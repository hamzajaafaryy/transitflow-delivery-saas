import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Config } from '../config.js';
import { one, transaction, type Database } from '../db.js';
import { ApiError, forbidden } from '../http.js';
import { authorize, type Permission, type Principal, type ResourceScope, type Role } from './authorization.js';
import { checkPassword, digest, token, unseal, verifyTotp } from './crypto.js';

const ttlSeconds = 8 * 60 * 60;
const email = z.string().trim().toLowerCase().email().max(150);
const loginInput = z.object({ login:email, password:z.string().min(1).max(256), totp:z.string().regex(/^\d{6}$/).optional() }).strict();
interface Account {
  id: string;
  role: Role;
  display_name: string;
  agency_id?: string;
  merchant_id?: string;
  active: boolean;
  presence: string;
  password_hash: string;
  mfa_enabled: boolean;
  mfa_secret_encrypted?: string;
  last_totp_step?: string;
  mfa_verified?: boolean;
  permissions?: Permission[];
}

export function mfaRequired(role: Role, grants: readonly Permission[]) {
  return role === 'ADMIN' || role === 'DEVELOPER' ||
    role === 'RESPONSABLE' && grants.includes('agency_payments.confirm_paid');
}

function name(secure: boolean) {
  return secure ? '__Host-tf_v2' : 'tf_v2_local';
}

function sessionHash(request: FastifyRequest, config: Config) {
  const prefix = name(config.secure) + '=';
  const item = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
  const value = item?.slice(prefix.length);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? digest(value) : null;
}

function setCookie(reply: FastifyReply, config: Config, value: string, maxAge: number) {
  reply.header('Set-Cookie',`${name(config.secure)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${config.secure?'; Secure':''}`);
}

const accountScope = `u.active AND u.presence<>'ABSENTE'
  AND (u.agency_id IS NULL OR EXISTS(SELECT FROM v2_agencies a WHERE a.id=u.agency_id AND a.active))
  AND (u.merchant_id IS NULL OR EXISTS(SELECT FROM v2_merchants m WHERE m.id=u.merchant_id AND m.active))`;
const grantsSql = 'ARRAY(SELECT p.permission_code FROM v2_user_permissions p WHERE p.user_id=u.id) AS permissions';

function principal(account: Account): Principal {
  return { id:account.id, displayName:account.display_name, role:account.role, active:account.active,
    agencyId:account.agency_id || undefined, merchantId:account.merchant_id || undefined, permissions:account.permissions ?? [] };
}

export function check(user: Principal, permission: Permission, scope?: ResourceScope) {
  if (!authorize(user,permission,scope).allowed) throw forbidden();
}

export function ownScope(user: Principal): ResourceScope {
  return user.role==='MERCHANT' ? { merchantId:user.merchantId } :
    user.role==='PARTNER_AGENCY' ? { agencyId:user.agencyId } : {};
}

export async function audit(db: Database, user: Principal, action: string, entity: string, id: string, metadata: Record<string, unknown> = {}) {
  await db.query(`INSERT INTO v2_audit_events(actor_id,agency_actor_id,action,entity_type,entity_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6)`, [user.role==='PARTNER_AGENCY'?null:user.id,user.role==='PARTNER_AGENCY'?user.agencyId:null,action,entity,id,metadata]);
}

export interface Context {
  app: FastifyInstance;
  pool: Pool;
  config: Config;
  user(request: FastifyRequest): Promise<Principal>;
}

export function sessions(app: FastifyInstance, pool: Pool, config: Config): Context {
  async function user(request: FastifyRequest) {
    const hash = sessionHash(request,config);
    if (!hash) throw new ApiError(401,'UNAUTHENTICATED','Connectez-vous pour continuer.');
    const account = await one<Account>(pool,`SELECT u.id,u.role,u.display_name,u.agency_id,u.merchant_id,u.active,u.mfa_enabled,
      s.mfa_verified,${grantsSql} FROM v2_sessions s JOIN v2_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND ${accountScope}`,[hash]);
    if (!account || (mfaRequired(account.role,account.permissions ?? []) || account.mfa_enabled) && !account.mfa_verified) {
      throw new ApiError(401,'UNAUTHENTICATED','Reconnectez-vous pour continuer.');
    }
    return principal(account);
  }

  app.post('/api/v2/auth/login', { config:{ rateLimit:{ max:20,timeWindow:'1 minute' } } }, async (request,reply) => {
    const input = loginInput.parse(request.body);
    const attemptKey = digest('login:' + input.login);
    const attempts = await one<{ attempts: number }>(pool,`INSERT INTO v2_login_limits(key_hash,attempts,reset_at)
      VALUES($1,1,now()+interval '10 minutes') ON CONFLICT(key_hash) DO UPDATE SET
      attempts=CASE WHEN v2_login_limits.reset_at<=now() THEN 1 ELSE v2_login_limits.attempts+1 END,
      reset_at=CASE WHEN v2_login_limits.reset_at<=now() THEN excluded.reset_at ELSE v2_login_limits.reset_at END RETURNING attempts`,[attemptKey]);
    if ((attempts?.attempts ?? 0) > 10) throw new ApiError(429,'LOGIN_RATE_LIMIT','Réessayez dans quelques minutes.');
    const account = await one<Account>(pool,`SELECT u.*,${grantsSql} FROM v2_users u WHERE u.login=$1 AND ${accountScope}`,[input.login]);
    const valid = await checkPassword(input.password,account?.password_hash ?? '');
    if (!account || !valid) throw new ApiError(401,'INVALID_LOGIN','Identifiant ou mot de passe incorrect.');
    const value = token();
    await transaction(pool,async db => {
      const locked = await one<Account>(db,`SELECT u.*,${grantsSql} FROM v2_users u WHERE u.id=$1 AND ${accountScope} FOR UPDATE OF u`,[account.id]);
      if (!locked || locked.password_hash !== account.password_hash) throw new ApiError(401,'INVALID_LOGIN','Reconnectez-vous.');
      const mfa = mfaRequired(locked.role,locked.permissions ?? []) || locked.mfa_enabled;
      if (mfa) {
        if (!locked.mfa_enabled || !locked.mfa_secret_encrypted) {
          throw new ApiError(403,'MFA_ENROLLMENT_REQUIRED','Le responsable technique doit activer la double authentification de ce compte.');
        }
        const seed = unseal(locked.mfa_secret_encrypted,config.dataKey,'mfa:' + locked.id);
        const step = input.totp && verifyTotp(seed,input.totp,Number(locked.last_totp_step ?? -1));
        if (typeof step !== 'number') throw new ApiError(401,'MFA_REQUIRED','Saisissez un code de double authentification valide.');
        await db.query('UPDATE v2_users SET last_totp_step=$2 WHERE id=$1',[locked.id,step]);
      }
      await db.query("INSERT INTO v2_sessions(token_hash,user_id,expires_at,mfa_verified) VALUES($1,$2,now()+interval '8 hours',$3)",
        [digest(value),locked.id,mfa]);
      await db.query('DELETE FROM v2_login_limits WHERE key_hash=$1',[attemptKey]);
      await audit(db,principal(locked),'LOGIN','SESSION',locked.id);
    });
    setCookie(reply,config,value,ttlSeconds);
    return { user: principal(account) };
  });

  app.get('/api/v2/auth/me',async request => ({ user:await user(request) }));
  app.post('/api/v2/auth/logout',async (request,reply) => {
    const hash = sessionHash(request,config);
    if (hash) await pool.query('DELETE FROM v2_sessions WHERE token_hash=$1',[hash]);
    setCookie(reply,config,'',0);
    return reply.code(204).send();
  });
  return { app,pool,config,user };
}
