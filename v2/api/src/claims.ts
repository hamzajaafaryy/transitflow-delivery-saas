import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import { lock, one, transaction, type Database, type Transaction } from './db.js';
import { ApiError, conflict, forbidden, missing, page, param, sendFile, text, uuid } from './http.js';
import { clearNotice, notify, notifyMerchant } from './notifications.js';
import { authorize, type Principal } from './security/authorization.js';
import { audit, check, ownScope, type Context } from './security/session.js';
import { workingMinutes } from './sla.js';

const base='/api/v2/claims';
const topics=['ORDER','PICKUP','STOCK','INVOICE','SETTLEMENT','RETURN','OTHER'] as const;
type Topic=typeof topics[number];
interface Claim { id:string;merchant_id:string;status:string;topic:Topic;assignee_id:string|null;reopen_count:number }
interface Agent { id:string;returns:boolean;general:boolean }
const live="status IN ('OUVERTE','EN_COURS','ESCALADEE')";
const refs:Record<Exclude<Topic,'OTHER'>,string>={
  ORDER:'v2_orders',PICKUP:'v2_pickups',STOCK:'v2_stock_products',INVOICE:'v2_merchant_invoices',
  SETTLEMENT:'v2_merchant_invoices',RETURN:'v2_merchant_return_bons',
};
const attachment=z.object({
  mime:z.enum(['image/jpeg','image/png','image/webp','application/pdf']),
  base64:z.string().min(4).max(2_800_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

async function available(db:Database) {
  return (await db.query<Agent>(`SELECT u.id,BOOL_OR(p.permission_code='returns.manage') AS returns,
    BOOL_OR(p.permission_code='claims.manage') AS general FROM v2_users u
    JOIN v2_user_permissions p ON p.user_id=u.id AND p.permission_code IN ('returns.manage','claims.manage')
    WHERE u.role IN ('RESPONSABLE','EMPLOYEE') AND u.active AND u.presence<>'ABSENTE' GROUP BY u.id ORDER BY u.id`)).rows;
}
async function assign(db:Transaction,row:Claim,agent:string|null) {
  if (row.assignee_id===agent) return;
  await db.query('UPDATE v2_complaints SET assignee_id=$2 WHERE id=$1',[row.id,agent]);
  await db.query(`INSERT INTO v2_audit_events(action,entity_type,entity_id,metadata) VALUES(
    'CLAIM_AUTO_ASSIGNMENT','CLAIM',$1,jsonb_build_object('previous',$2::uuid,'next',$3::uuid))`,[row.id,row.assignee_id,agent]);
}
async function chooseGeneral(db:Transaction,merchantId:string,agents:Agent[]) {
  if (!agents.length) return null;
  const result=await one<{id:string}>(db,`SELECT u.id FROM unnest($1::uuid[]) u(id) LEFT JOIN v2_complaints c ON c.assignee_id=u.id
    GROUP BY u.id ORDER BY COUNT(c.id) FILTER(WHERE c.merchant_id=$2 AND c.${live}) DESC,
    COUNT(c.id) FILTER(WHERE c.${live}),MAX(c.updated_at) NULLS FIRST,u.id LIMIT 1`,[agents.map(row=>row.id),merchantId]);
  return result?.id??null;
}

export async function rebalanceClaims(db:Transaction) {
  await lock(db,'claims','assignments');
  const agents=await available(db),returns=agents.filter(row=>row.returns),general=agents.filter(row=>row.general);
  const claims=(await db.query<Claim>(`SELECT id,merchant_id,status,topic,assignee_id,reopen_count FROM v2_complaints
    WHERE status IN ('OUVERTE','EN_COURS') ORDER BY created_at,id FOR UPDATE`)).rows;
  const returnClaims=claims.filter(row=>row.topic==='RETURN');
  for (const [index,row] of returnClaims.entries()) {
    if (returns.length && returnClaims.length>10) {
      await assign(db,row,returns[index%returns.length].id);
    } else if (returns.length) {
      if (row.assignee_id&&!returns.some(agent=>agent.id===row.assignee_id)) {
        const next=await chooseGeneral(db,row.merchant_id,returns);
        await assign(db,row,next);
      }
    } else if (!row.assignee_id || !general.some(agent=>agent.id===row.assignee_id)) {
      await assign(db,row,await chooseGeneral(db,row.merchant_id,general));
    }
  }
  for (const row of claims.filter(row=>row.topic!=='RETURN')) {
    if (!row.assignee_id || !general.some(agent=>agent.id===row.assignee_id)) await assign(db,row,await chooseGeneral(db,row.merchant_id,general));
  }
}

async function lookup(db:Database,user:Principal,id:string,locked=false) {
  const row=await one<Claim>(db,`SELECT c.*,m.name AS merchant,u.display_name AS assignee FROM v2_complaints c
    JOIN v2_merchants m ON m.id=c.merchant_id LEFT JOIN v2_users u ON u.id=c.assignee_id
    WHERE c.id=$1 AND ($2::uuid IS NULL OR c.merchant_id=$2)${locked?' FOR UPDATE OF c':''}`,[id,user.merchantId??null]);
  if (!row) throw missing('Réclamation introuvable.');
  if (!user.merchantId && row.status==='ESCALADEE' && user.role!=='ADMIN' && row.assignee_id!==user.id) throw missing();
  check(user,user.merchantId?'claims.read':'claims.manage',{...ownScope(user),returnClaim:row.topic==='RETURN'});
  return row;
}
async function alerts(db:Transaction,row:Claim) {
  const agents=await available(db),returns=agents.filter(agent=>agent.returns);
  const recipients=row.topic==='RETURN'&&returns.length?returns.map(agent=>agent.id):row.assignee_id?[row.assignee_id]:[];
  await notify(db,recipients,'claim-waiting:'+row.id,'Un message marchand attend une réponse.',row.id);
}
async function file(db:Transaction,user:Principal,value:z.infer<typeof attachment>|undefined) {
  if (!value) return null;
  const data=Buffer.from(value.base64,'base64'),prefix=data.toString('hex',0,12);
  const valid= value.mime==='application/pdf'&&prefix.startsWith('255044462d') ||
    value.mime==='image/png'&&prefix.startsWith('89504e470d0a1a0a') ||
    value.mime==='image/jpeg'&&prefix.startsWith('ffd8ff') ||
    value.mime==='image/webp'&&prefix.startsWith('52494646')&&prefix.slice(16)==='57454250';
  if (!valid || data.length>2_000_000) throw new ApiError(422,'FILE_INVALID','Pièce jointe non valide.');
  return (await one<{id:string}>(db,'INSERT INTO v2_private_files(mime,data,owner_id) VALUES($1,$2,$3) RETURNING id',[value.mime,data,user.id]))!.id;
}

export async function monitorClaims(db:Transaction) {
  const pending=(await db.query<{id:string;waiting_since:Date}>(`SELECT id,waiting_since FROM v2_complaints WHERE ${live}
    AND waiting_since<now()-interval '2 hours' AND manager_alerted_at IS NULL ORDER BY waiting_since LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows;
  if (!pending.length) return;
  const [holidays,managers]=await Promise.all([
    db.query<{day:string}>('SELECT day::text FROM v2_holidays'),
    db.query<{id:string}>(`SELECT u.id FROM v2_users u WHERE u.active AND u.presence<>'ABSENTE'
      AND (u.role='ADMIN' OR u.role='RESPONSABLE' AND EXISTS(SELECT FROM v2_user_permissions p WHERE p.user_id=u.id AND p.permission_code='claims.supervise'))`),
  ]);
  const days=new Set(holidays.rows.map(row=>row.day));
  for (const row of pending) {
    if (workingMinutes(row.waiting_since,new Date(),days)<120) continue;
    await notify(db,managers.rows.map(u=>u.id),'claim-sla:'+row.id,'Réclamation sans réponse depuis 2 heures ouvrées.',row.id);
    await db.query('UPDATE v2_complaints SET manager_alerted_at=clock_timestamp() WHERE id=$1',[row.id]);
  }
}

export function claimRoutes(ctx:Context,signals:EventEmitter) {
  const {app,pool}=ctx;
  const connections=new Map<string,number>();
  app.get(base+'/:id/stream',async (request,reply)=>{
    const user=await ctx.user(request),id=param(request);
    await lookup(pool,user,id);
    const count=connections.get(user.id)??0;
    if (count>=3) throw new ApiError(429,'STREAM_LIMIT','Trop de conversations ouvertes.');
    connections.set(user.id,count+1);
    reply.hijack();
    const response=reply.raw;
    response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'private, no-store',
      'X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    response.write('retry: 2000\n\n: connected\n\n');
    let checking=false;
    async function refresh() {
      if (checking||response.destroyed) return;
      checking=true;
      try {
        await lookup(pool,await ctx.user(request),id);
        response.write('event: refresh\ndata: {}\n\n');
      } catch {
        response.end();
      } finally {
        checking=false;
      }
    }
    signals.on(id,refresh);
    const heartbeat=setInterval(refresh,20_000);
    const timeout=setTimeout(()=>response.end(),120_000);
    response.on('close',()=>{
      clearInterval(heartbeat);
      clearTimeout(timeout);
      signals.off(id,refresh);
      const remaining=(connections.get(user.id)??1)-1;
      if (remaining) connections.set(user.id,remaining);
      else connections.delete(user.id);
    });
  });
  app.get(base,async request=>{
    const user=await ctx.user(request);
    const general=authorize(user,'claims.manage').allowed;
    if (!general) check(user,user.merchantId?'claims.read':'claims.manage',{...ownScope(user),returnClaim:true});
    const query=z.object({page}).parse(request.query);
    const {rows}=await pool.query(`SELECT c.*,m.name AS merchant,u.display_name AS assignee,COUNT(*) OVER()::int AS total
      FROM v2_complaints c JOIN v2_merchants m ON m.id=c.merchant_id LEFT JOIN v2_users u ON u.id=c.assignee_id
      WHERE ($1::uuid IS NULL OR c.merchant_id=$1) AND ($2 OR c.topic='RETURN')
      AND ($3 OR c.status<>'ESCALADEE' OR c.assignee_id=$4) ORDER BY c.updated_at DESC,c.id LIMIT 50 OFFSET $5`,
      [user.merchantId??null,general||Boolean(user.merchantId),Boolean(user.merchantId)||user.role==='ADMIN',user.id,(query.page-1)*50]);
    const holidays=new Set((await pool.query<{day:string}>('SELECT day::text FROM v2_holidays')).rows.map(row=>row.day));
    return { rows:rows.map(row=>({...row,sla:!user.merchantId&&row.waiting_since&&workingMinutes(row.waiting_since,new Date(),holidays)>=60?'LATE':null})),
      page:query.page,total:rows[0]?.total??0 };
  });
  app.post(base,{bodyLimit:3_000_000},async (request,reply)=>{
    const user=await ctx.user(request); check(user,'claims.create',ownScope(user));
    if (!user.merchantId) throw forbidden();
    const input=z.object({topic:z.enum(topics),referenceId:uuid.optional(),subject:text(160),message:text(4000),
      parcels:z.array(uuid).max(500).default([]),attachment:attachment.optional()}).strict().parse(request.body);
    const row=await transaction(pool,async db=>{
      await lock(db,'claims','assignments');
      if (input.topic!=='OTHER') {
        if (!input.referenceId || !await one(db,`SELECT id FROM ${refs[input.topic]} WHERE id=$1 AND merchant_id=$2`,[input.referenceId,user.merchantId])) throw missing('Référence introuvable.');
      }
      if (input.parcels.length && (input.topic!=='RETURN' || (await db.query(`SELECT order_id FROM v2_merchant_return_lines
        WHERE bon_id=$1 AND order_id=ANY($2::uuid[])`,[input.referenceId,input.parcels])).rowCount!==new Set(input.parcels).size)) {
        throw new ApiError(422,'INVALID_PARCELS','Sélectionnez des colis du bon concerné.');
      }
      const created=await one<Claim>(db,`INSERT INTO v2_complaints(merchant_id,topic,reference_id,subject,waiting_since)
        VALUES($1,$2,$3,$4,clock_timestamp()) RETURNING *`,[user.merchantId,input.topic,input.topic==='OTHER'?null:input.referenceId,input.subject]);
      await db.query('INSERT INTO v2_complaint_messages(complaint_id,actor_id,body,file_id) VALUES($1,$2,$3,$4)',
        [created!.id,user.id,input.message,await file(db,user,input.attachment)]);
      await db.query('INSERT INTO v2_complaint_parcels SELECT $1,id FROM unnest($2::uuid[]) AS t(id)',[created!.id,[...new Set(input.parcels)]]);
      await rebalanceClaims(db);
      const refreshed=(await one<Claim>(db,'SELECT * FROM v2_complaints WHERE id=$1',[created!.id]))!;
      await alerts(db,refreshed);
      await audit(db,user,'CLAIM_CREATED','CLAIM',created!.id,{topic:input.topic});
      return refreshed;
    });
    return reply.code(201).send(row);
  });
  app.get(base+'/:id',async request=>{
    const user=await ctx.user(request);
    const claim=await lookup(pool,user,param(request));
    const [messages,parcels]=await Promise.all([
      pool.query(`SELECT m.id,m.body,m.private_note,m.file_id,m.created_at,u.display_name AS author,u.role FROM v2_complaint_messages m
        JOIN v2_users u ON u.id=m.actor_id WHERE m.complaint_id=$1 AND (NOT $2 OR NOT m.private_note) ORDER BY m.id`,[claim.id,Boolean(user.merchantId)]),
      pool.query(`SELECT o.id,o.tracking_code FROM v2_complaint_parcels p JOIN v2_orders o ON o.id=p.order_id WHERE p.complaint_id=$1 ORDER BY o.tracking_code`,[claim.id]),
    ]);
    return { claim,messages:messages.rows,parcels:parcels.rows };
  });
  app.post(base+'/:id/messages',{bodyLimit:3_000_000},async request=>{
    const user=await ctx.user(request),id=param(request);
    const input=z.object({body:text(4000),privateNote:z.boolean().default(false),attachment:attachment.optional()}).strict().parse(request.body);
    if (user.merchantId&&input.privateNote) throw forbidden();
    return transaction(pool,async db=>{
      const row=await lookup(db,user,id,true);
      if (!['OUVERTE','EN_COURS','ESCALADEE'].includes(row.status)) throw conflict('CLAIM_CLOSED','Rouvrez la réclamation pour écrire.');
      await db.query('INSERT INTO v2_complaint_messages(complaint_id,actor_id,body,private_note,file_id) VALUES($1,$2,$3,$4,$5)',
        [id,user.id,input.body,input.privateNote,await file(db,user,input.attachment)]);
      if (!input.privateNote) {
        await db.query(`UPDATE v2_complaints SET waiting_since=CASE WHEN $2 THEN COALESCE(waiting_since,clock_timestamp()) END,
          manager_alerted_at=CASE WHEN $2 THEN manager_alerted_at END,updated_at=clock_timestamp() WHERE id=$1`,[id,Boolean(user.merchantId)]);
        if (user.merchantId) await alerts(db,row);
        else {
          await clearNotice(db,'claim-waiting:'+id);
          await clearNotice(db,'claim-sla:'+id);
          await notifyMerchant(db,row.merchant_id,'claim-reply:'+id,'Une réponse a été ajoutée à votre réclamation.',id);
        }
      } else await db.query('UPDATE v2_complaints SET updated_at=clock_timestamp() WHERE id=$1',[id]);
      await audit(db,user,'CLAIM_MESSAGE','CLAIM',id,{private:input.privateNote});
      return { sent:true };
    });
  });
  app.post(base+'/:id/state',async request=>{
    const user=await ctx.user(request),id=param(request);
    const input=z.object({action:z.enum(['CLAIM','RESOLVE','CLOSE','ESCALATE','DELEGATE','CANCEL','REOPEN','URGENT']),
      assigneeId:uuid.optional(),urgent:z.boolean().optional()}).strict().parse(request.body);
    return transaction(pool,async db=>{
      await lock(db,'claims','assignments');
      const row=await lookup(db,user,id,true);
      const merchantAction=input.action==='CANCEL'||input.action==='REOPEN';
      if (merchantAction!==Boolean(user.merchantId)) throw forbidden();
      const active=['OUVERTE','EN_COURS','ESCALADEE'].includes(row.status);
      let status=row.status;
      if (input.action==='CLAIM' && active && row.topic==='RETURN' && !row.assignee_id) {
        check(user,'returns.manage');
        const count=(await one<{count:number}>(db,`SELECT COUNT(*)::int AS count FROM v2_complaints WHERE topic='RETURN' AND ${live}`))!.count;
        if (count>10) throw conflict('AUTO_BALANCED','Attribution automatique active.');
        await db.query('UPDATE v2_complaints SET assignee_id=$2 WHERE id=$1',[id,user.id]);
        status='EN_COURS';
      } else if (input.action==='DELEGATE' && row.status==='ESCALADEE' && user.role==='ADMIN' && input.assigneeId) {
        const allowed=(await available(db)).some(a=>a.id===input.assigneeId && (a.general||a.returns&&row.topic==='RETURN'));
        if (!allowed) throw forbidden();
        await db.query('UPDATE v2_complaints SET assignee_id=$2 WHERE id=$1',[id,input.assigneeId]);
      } else if (input.action==='URGENT'&&user.role==='ADMIN'&&input.urgent!==undefined) {
        await db.query('UPDATE v2_complaints SET urgent=$2 WHERE id=$1',[id,input.urgent]);
      } else if (input.action==='ESCALATE'&&active&&row.status!=='ESCALADEE') {
        status='ESCALADEE';
        await db.query('UPDATE v2_complaints SET assignee_id=NULL WHERE id=$1',[id]);
        await clearNotice(db,'claim-waiting:'+id);
      } else if (['RESOLVE','CLOSE'].includes(input.action) && (active||row.status==='RESOLUE')) {
        status=input.action==='CLOSE'?'FERMEE':'RESOLUE';
        await notifyMerchant(db,row.merchant_id,'claim-state:'+id,'Votre réclamation a été traitée.',id);
      } else if (input.action==='CANCEL' && row.status!=='ANNULEE') {
        status='ANNULEE';
      } else if (input.action==='REOPEN' && ['FERMEE','RESOLUE'].includes(row.status) && row.reopen_count<3) {
        status='OUVERTE';
        await db.query(`UPDATE v2_complaints SET reopen_count=reopen_count+1,waiting_since=clock_timestamp(),manager_alerted_at=NULL WHERE id=$1`,[id]);
      } else throw conflict('CLAIM_STATE','Cette action est indisponible dans cet état.');
      await db.query(`UPDATE v2_complaints SET status=$2,updated_at=clock_timestamp(),waiting_since=
        CASE WHEN $2 IN ('ANNULEE','FERMEE','RESOLUE') THEN NULL ELSE waiting_since END WHERE id=$1`,[id,status]);
      if (['ANNULEE','FERMEE','RESOLUE'].includes(status)) {
        await clearNotice(db,'claim-waiting:'+id);
        await clearNotice(db,'claim-sla:'+id);
      }
      await rebalanceClaims(db);
      if (input.action==='REOPEN') await alerts(db,(await one<Claim>(db,'SELECT * FROM v2_complaints WHERE id=$1',[id]))!);
      await audit(db,user,'CLAIM_'+input.action,'CLAIM',id,{status,assigneeId:input.assigneeId});
      return { status };
    });
  });
  app.get(base+'/:id/files/:fileId',async (request,reply)=>{
    const user=await ctx.user(request),id=param(request);
    await lookup(pool,user,id);
    const data=await one<{mime:string;data:Buffer}>(pool,`SELECT f.mime,f.data FROM v2_private_files f JOIN v2_complaint_messages m ON m.file_id=f.id
      WHERE f.id=$1 AND m.complaint_id=$2 AND (NOT $3 OR NOT m.private_note)`,[param(request,'fileId'),id,Boolean(user.merchantId)]);
    if (!data) throw missing();
    return sendFile(reply,'piece-jointe.'+data.mime.split('/')[1],data.mime,data.data);
  });
  app.get(base+'/performance',async request=>{
    const user=await ctx.user(request);
    if (!['ADMIN','RESPONSABLE'].includes(user.role)) throw forbidden();
    check(user,'claims.supervise');
    const {rows}=await pool.query(`SELECT u.id,u.display_name,COUNT(c.id) FILTER(WHERE c.${live})::int AS active,
      COUNT(c.id) FILTER(WHERE c.status IN ('RESOLUE','FERMEE'))::int AS closed FROM v2_users u
      JOIN v2_complaints c ON c.assignee_id=u.id GROUP BY u.id ORDER BY active DESC,u.display_name`);
    return { rows };
  });
  app.put('/api/v2/settings/holidays',async request=>{
    const user=await ctx.user(request); check(user,'settings.manage');
    const value=z.object({day:z.iso.date(),label:text(100)}).strict().parse(request.body);
    await pool.query('INSERT INTO v2_holidays(day,label) VALUES($1,$2) ON CONFLICT(day) DO UPDATE SET label=excluded.label',[value.day,value.label]);
    return { saved:true };
  });
}
