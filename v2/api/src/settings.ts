import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, transaction, type Transaction } from './db.js';
import { normalizeCity, packaging } from './domain.js';
import { centimes, conflict, forbidden, missing, param, text, uuid } from './http.js';
import { exportHeaders } from './orders.js';
import { agencyPermissions, authorize, merchantPermissions, permissions, roles, type Permission, type Role } from './security/authorization.js';
import { hashPassword, seal, totpAt } from './security/crypto.js';
import { audit, check, mfaRequired, ownScope, type Context } from './security/session.js';

export const accountInput=z.object({
  login:z.string().trim().toLowerCase().email().max(150), name:text(100), password:z.string().min(14).max(256),
  role:z.enum(roles), agencyId:uuid.optional(), merchantId:uuid.optional(),zone:text(80).optional(),
  grants:z.array(z.enum(permissions)).max(permissions.length).default([]),
  totpSeed:z.string().trim().toUpperCase().regex(/^[A-Z2-7]{32,128}$/).optional(),
}).strict().refine(x=>(x.role==='MERCHANT')===Boolean(x.merchantId)&&(x.role==='PARTNER_AGENCY')===Boolean(x.agencyId))
  .refine(x=>!mfaRequired(x.role,x.grants)||x.totpSeed)
  .refine(x=>x.role==='RESPONSABLE'||!x.grants.includes('agency_payments.confirm_paid'));

export async function provisionAccount(db:Transaction,dataKey:Buffer,input:z.infer<typeof accountInput>,grantedBy?:string) {
  const id=randomUUID();
  if (input.totpSeed) totpAt(input.totpSeed,0);
  await db.query(`INSERT INTO v2_users(id,role,login,display_name,password_hash,agency_id,merchant_id,zone,mfa_enabled,mfa_secret_encrypted)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,input.role,input.login,input.name,await hashPassword(input.password),
    input.agencyId??null,input.merchantId??null,input.zone?normalizeCity(input.zone):null,Boolean(input.totpSeed),
    input.totpSeed?seal(input.totpSeed,dataKey,'mfa:'+id):null]);
  const grants:readonly Permission[]=input.role==='MERCHANT'?merchantPermissions:input.role==='PARTNER_AGENCY'?agencyPermissions:input.grants;
  await db.query(`INSERT INTO v2_user_permissions(user_id,permission_code,granted_by)
    SELECT $1,x,$3 FROM unnest($2::text[]) AS t(x)`,[id,[...new Set(grants)],grantedBy??id]);
  return { id };
}

interface AccountRow { id:string;role:Role;mfa_enabled:boolean;agency_id:string|null;merchant_id:string|null }
const presence=z.enum(['PRESENTE','TT','ABSENTE']);
export function settingsRoutes(ctx:Context,refreshClaims:(db:Transaction)=>Promise<void>) {
  const { app,pool,config }=ctx;
  app.get('/api/v2/references',async request=>{
    const user=await ctx.user(request);
    const mayAgencies=['settings.manage','dispatch.manage','returns.read','agency_payments.read','agency_payments.create','orders.read'].some(permission=>
      !user.merchantId && authorize(user,permission as Permission,ownScope(user)).allowed);
    const mayMerchants=['settings.manage','orders.read','orders.create','stock.read','merchant_returns.read','merchant_finance.read','pickups.manage'].some(permission=>
      !user.agencyId && authorize(user,permission as Permission,ownScope(user)).allowed);
    const [agencies,merchants,cities]=await Promise.all([
      mayAgencies?pool.query('SELECT id,name,city FROM v2_agencies WHERE active AND ($1::uuid IS NULL OR id=$1) ORDER BY city,name',[user.agencyId??null]):null,
      mayMerchants?pool.query('SELECT id,name FROM v2_merchants WHERE active AND ($1::uuid IS NULL OR id=$1) ORDER BY name',[user.merchantId??null]):null,
      pool.query('SELECT DISTINCT city FROM v2_agencies WHERE active ORDER BY city'),
    ]);
    return { agencies:agencies?.rows??[],merchants:merchants?.rows??[],cities:cities.rows.map(row=>row.city) };
  });
  app.get('/api/v2/overview',async request=>{
    const user=await ctx.user(request); check(user,'orders.read',ownScope(user));
    const {rows}=await pool.query(`SELECT status,COUNT(*)::int AS count FROM v2_orders
      WHERE ($1::uuid IS NULL OR merchant_id=$1) AND ($2::uuid IS NULL OR current_holder_type='AGENCY' AND current_holder_id=$2)
      GROUP BY status ORDER BY count DESC,status`,[user.merchantId??null,user.agencyId??null]);
    return { counts:rows,scope:user.agencyId?'AGENCY':user.merchantId?'MERCHANT':'STAFF' };
  });
  app.get('/api/v2/settings/users',async request=>{
    const user=await ctx.user(request); check(user,'users.manage');
    const {rows}=await pool.query(`SELECT id,display_name,role,login,active,mfa_enabled,presence,zone,
      ARRAY(SELECT permission_code FROM v2_user_permissions p WHERE p.user_id=u.id ORDER BY permission_code) AS permissions
      FROM v2_users u WHERE ($1 OR role='EMPLOYEE') ORDER BY display_name,id`,[user.role==='ADMIN'||user.role==='DEVELOPER']);
    return { rows,permissions };
  });
  app.post('/api/v2/settings/users',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'users.manage');
    const input=accountInput.parse(request.body);
    if (input.role==='DEVELOPER'||input.role==='ADMIN' || user.role!=='ADMIN' && user.role!=='DEVELOPER' &&
      (user.role!=='RESPONSABLE'||input.role!=='EMPLOYEE'||input.grants.some(p=>!user.permissions.includes(p)))) throw forbidden();
    const account=await transaction(pool,async db=>{
      const row=await provisionAccount(db,config.dataKey,input,user.id);
      await audit(db,user,'ACCOUNT_CREATED','USER',row.id,{role:input.role});
      return row;
    });
    return reply.code(201).send(account);
  });
  app.put('/api/v2/settings/users/:id',async request=>{
    const user=await ctx.user(request); check(user,'users.manage');
    const input=z.object({presence:presence.optional(),active:z.boolean().optional(),grants:z.array(z.enum(permissions)).optional()}).strict().parse(request.body);
    const id=param(request);
    if (id===user.id) throw forbidden();
    return transaction(pool,async db=>{
      const target=await one<AccountRow>(db,'SELECT id,role,mfa_enabled,agency_id,merchant_id FROM v2_users WHERE id=$1 FOR UPDATE',[id]);
      if (!target) throw missing();
      if (target.role==='ADMIN'||target.role==='DEVELOPER' || user.role!=='ADMIN'&&user.role!=='DEVELOPER'&&
        (user.role!=='RESPONSABLE'||target.role!=='EMPLOYEE'||input.grants?.some(p=>!user.permissions.includes(p)))) throw forbidden();
      if (input.grants?.includes('agency_payments.confirm_paid')&&(target.role!=='RESPONSABLE'||!target.mfa_enabled)) {
        throw conflict('FINANCE_MFA','Cette permission exige un compte Responsable avec double authentification.');
      }
      if (input.grants) {
        const allowed=target.role==='MERCHANT'?merchantPermissions:target.role==='PARTNER_AGENCY'?agencyPermissions:permissions;
        if (input.grants.some(p=>!allowed.includes(p))) throw forbidden();
        if (user.role==='RESPONSABLE') {
          const unmanaged=await one(db,'SELECT 1 FROM v2_user_permissions WHERE user_id=$1 AND NOT permission_code=ANY($2::text[])',[id,user.permissions]);
          if (unmanaged) throw forbidden();
        }
        await db.query('DELETE FROM v2_user_permissions WHERE user_id=$1',[id]);
        await db.query(`INSERT INTO v2_user_permissions(user_id,permission_code,granted_by)
          SELECT $1,p,$3 FROM unnest($2::text[]) p`,[id,[...new Set(input.grants)],user.id]);
      }
      await db.query('UPDATE v2_users SET presence=COALESCE($2,presence),active=COALESCE($3,active) WHERE id=$1',[id,input.presence??null,input.active??null]);
      if (input.presence==='ABSENTE'||input.active===false) await db.query('DELETE FROM v2_sessions WHERE user_id=$1',[id]);
      await audit(db,user,'ACCOUNT_UPDATED','USER',id,input);
      if (input.grants||input.presence||input.active!==undefined) await refreshClaims(db);
      return { updated:true };
    });
  });
  app.post('/api/v2/settings/agencies',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'settings.manage');
    const input=z.object({name:text(120),city:text(80),returnHeader:text(80).default('CODE SUIVI'),
      dispatchHeaders:z.array(text(80)).length(11).default(exportHeaders)}).strict().parse(request.body);
    const row=await transaction(pool,async db=>{
      const agency=await one<{id:string}>(db,`INSERT INTO v2_agencies(name,city,return_excel_header,dispatch_excel_headers)
        VALUES($1,$2,$3,$4) RETURNING id,name,city`,[input.name,normalizeCity(input.city),input.returnHeader,input.dispatchHeaders]);
      await audit(db,user,'AGENCY_CREATED','AGENCY',agency!.id);
      return agency;
    });
    return reply.code(201).send(row);
  });
  app.put('/api/v2/settings/agencies/:id/templates',async request=>{
    const user=await ctx.user(request); check(user,'settings.manage');
    const id=param(request);
    const input=z.object({returnHeader:text(80),dispatchHeaders:z.array(text(80)).length(11)}).strict().parse(request.body);
    return transaction(pool,async db=>{
      const result=await db.query('UPDATE v2_agencies SET return_excel_header=$2,dispatch_excel_headers=$3 WHERE id=$1',[id,input.returnHeader,input.dispatchHeaders]);
      if (!result.rowCount) throw missing();
      await audit(db,user,'AGENCY_TEMPLATES_UPDATED','AGENCY',id);
      return { updated:true };
    });
  });
  app.post('/api/v2/settings/merchants',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'settings.manage');
    const input=z.object({name:text(120),phone:z.string().regex(/^\+?[0-9 ()-]{8,24}$/).optional(),refusedFee:centimes.default(0)}).strict().parse(request.body);
    const row=await transaction(pool,async db=>{
      const merchant=await one<{id:string}>(db,'INSERT INTO v2_merchants(name,phone,refused_fee_centimes) VALUES($1,$2,$3) RETURNING id,name',
        [input.name,input.phone??null,input.refusedFee]);
      await audit(db,user,'MERCHANT_CREATED','MERCHANT',merchant!.id);
      return merchant;
    });
    return reply.code(201).send(row);
  });
  app.put('/api/v2/settings/merchants/:id/rates',async request=>{
    const user=await ctx.user(request); check(user,'settings.manage');
    const id=param(request);
    const input=z.object({delivery:z.array(z.object({city:text(80),centimes})).max(300).default([]),
      packaging:z.array(z.object({kind:packaging,centimes})).max(4).default([]),refusedFee:centimes.optional()}).strict().parse(request.body);
    return transaction(pool,async db=>{
      if (!await one(db,'SELECT id FROM v2_merchants WHERE id=$1 FOR UPDATE',[id])) throw missing();
      for (const rate of input.delivery) await db.query(`INSERT INTO v2_merchant_rates VALUES($1,$2,$3)
        ON CONFLICT(merchant_id,city) DO UPDATE SET delivery_fee_centimes=excluded.delivery_fee_centimes`,[id,normalizeCity(rate.city),rate.centimes]);
      for (const rate of input.packaging) await db.query(`INSERT INTO v2_packaging_rates VALUES($1,$2,$3)
        ON CONFLICT(merchant_id,kind) DO UPDATE SET centimes=excluded.centimes`,[id,rate.kind,rate.centimes]);
      if (input.refusedFee!==undefined) await db.query('UPDATE v2_merchants SET refused_fee_centimes=$2 WHERE id=$1',[id,input.refusedFee]);
      await audit(db,user,'MERCHANT_RATES_UPDATED','MERCHANT',id,input);
      return { updated:true };
    });
  });
}
