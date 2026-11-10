import { z } from 'zod';
import { one, transaction } from './db.js';
import { normalizeCity } from './domain.js';
import { date, forbidden, conflict, missing, page, param, text, uuid } from './http.js';
import { authorize } from './security/authorization.js';
import { audit, check, ownScope, type Context } from './security/session.js';

export function pickupRoutes(ctx:Context) {
  const { app,pool }=ctx;
  app.get('/api/v2/pickups',async request=>{
    const user=await ctx.user(request);
    const managed=authorize(user,'pickups.manage').allowed;
    if (!managed) check(user,user.merchantId?'pickups.create':'pickups.collect',ownScope(user));
    const query=z.object({page}).parse(request.query);
    const {rows}=await pool.query(`SELECT p.*,m.name AS merchant,u.display_name AS assignee,COUNT(*) OVER()::int AS total
      FROM v2_pickups p JOIN v2_merchants m ON m.id=p.merchant_id LEFT JOIN v2_users u ON u.id=p.assignee_id
      WHERE ($1::uuid IS NULL OR p.merchant_id=$1) AND ($2::uuid IS NULL OR p.assignee_id=$2)
      ORDER BY p.created_at DESC,p.id LIMIT 50 OFFSET $3`,[user.merchantId??null,!managed&&!user.merchantId?user.id:null,(query.page-1)*50]);
    return { rows,total:rows[0]?.total??0,page:query.page };
  });
  app.post('/api/v2/pickups',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'pickups.create',ownScope(user));
    const input=z.object({merchantId:uuid.optional(),zone:text(80),address:text(250),scheduledAt:date.optional()}).strict().parse(request.body);
    if (user.merchantId && input.merchantId && user.merchantId!==input.merchantId) throw forbidden();
    const id=user.merchantId??input.merchantId;
    if (!id) throw missing('Choisissez un marchand.');
    const row=await transaction(pool,async db=>{
      const result=await one<{id:string}>(db,`INSERT INTO v2_pickups(merchant_id,zone,address,scheduled_at)
        VALUES($1,$2,$3,$4) RETURNING *`,[id,normalizeCity(input.zone),input.address,input.scheduledAt??null]);
      await audit(db,user,'PICKUP_REQUESTED','PICKUP',result!.id);
      return result;
    });
    return reply.code(201).send(row);
  });
  app.get('/api/v2/pickups/collectors',async request=>{
    const user=await ctx.user(request); check(user,'pickups.manage');
    const {rows}=await pool.query(`SELECT u.id,u.display_name,u.zone FROM v2_users u
      WHERE u.active AND u.presence<>'ABSENTE' AND EXISTS(SELECT FROM v2_user_permissions p WHERE p.user_id=u.id AND p.permission_code='pickups.collect')
      ORDER BY u.zone,u.display_name`);
    return { rows };
  });
  app.post('/api/v2/pickups/:id/state',async request=>{
    const user=await ctx.user(request),id=param(request);
    const input=z.object({action:z.enum(['ASSIGN','PICK','POSTPONE','CLOSE','CANCEL']),assigneeId:uuid.optional(),
      scheduledAt:date.optional()}).strict().parse(request.body);
    if (input.action==='PICK') check(user,'pickups.collect');
    else if (user.merchantId && input.action==='CANCEL') check(user,'pickups.create',ownScope(user));
    else check(user,'pickups.manage');
    return transaction(pool,async db=>{
      const row=await one<{status:string;zone:string;assignee_id:string|null}>(db,`SELECT * FROM v2_pickups
        WHERE id=$1 AND ($2::uuid IS NULL OR merchant_id=$2) FOR UPDATE`,[id,user.merchantId??null]);
      if (!row) throw missing();
      const beforePick=['EN_ATTENTE','AFFECTE','REPORTE'].includes(row.status);
      if (input.action==='PICK' && row.assignee_id!==user.id) throw forbidden();
      const states={
        ASSIGN:beforePick&&input.assigneeId?'AFFECTE':null,
        PICK:row.status==='AFFECTE'?'PICKED':null,
        POSTPONE:beforePick&&input.scheduledAt?'REPORTE':null,
        CLOSE:row.status==='PICKED'?'TERMINE':null,
        CANCEL:beforePick?'ANNULE':null,
      };
      const status=states[input.action];
      if (!status) throw conflict('PICKUP_STATUS','Action indisponible dans cet état.');
      if (input.action==='ASSIGN') {
        const collector=await one(db,`SELECT u.id FROM v2_users u JOIN v2_user_permissions p ON p.user_id=u.id
          WHERE u.id=$1 AND u.zone=$2 AND u.active AND u.presence<>'ABSENTE' AND p.permission_code='pickups.collect'`,[input.assigneeId,row.zone]);
        if (!collector) throw conflict('PICKUP_ZONE','Choisissez un ramasseur disponible dans cette zone.');
      }
      await db.query(`UPDATE v2_pickups SET status=$2,updated_at=clock_timestamp(),
        assignee_id=COALESCE($3,assignee_id),scheduled_at=COALESCE($4,scheduled_at) WHERE id=$1`,
        [id,status,input.action==='ASSIGN'?input.assigneeId:null,input.scheduledAt??null]);
      await audit(db,user,'PICKUP_'+input.action,'PICKUP',id,{ status,assigneeId:input.assigneeId });
      return { id,status };
    });
  });
}
