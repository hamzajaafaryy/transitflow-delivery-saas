import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, transaction, type Transaction } from './db.js';
import { activeAgency, filterWindow, normalizeCity, scanInput, statusEvent, type Order, type Scan } from './domain.js';
import { workbook, xlsxMime } from './documents.js';
import { ApiError, code, conflict, missing, page, param, sendFile, text, uuid } from './http.js';
import { confirmScan, existingScan, exportValues, physicalEvent } from './orders.js';
import type { Principal } from './security/authorization.js';
import { audit, check, type Context } from './security/session.js';

interface Bon {
  id:string; agency_id:string; city:string; status:'EN_PREPARATION'|'ENVOYE'|'RECU'; first_received_at:Date|null;
}
const selection=z.object({
  ids:z.array(uuid).min(1).max(5000).optional(),all:z.literal(true).optional(),search:text(120).optional(),merchantId:uuid.optional(),
}).strict().refine(input=>Boolean(input.ids)!==Boolean(input.all));

async function getBon(db: Transaction,id: string,locked=false) {
  const bon=await one<Bon>(db,`SELECT * FROM v2_dispatch_bons WHERE id=$1 AND deleted_at IS NULL${locked?' FOR UPDATE':''}`,[id]);
  if (!bon) throw missing('Bon d’envoi introuvable.');
  return bon;
}

async function add(db: Transaction,bon: Bon,user: Principal,input:z.infer<typeof selection>) {
  if (bon.status!=='EN_PREPARATION' || bon.first_received_at) throw conflict('DISPATCH_LOCKED','Rouvrez le bon avant de modifier sa liste.');
  const orders=(await db.query<Order>(`SELECT o.* FROM v2_orders o WHERE o.city=$1 AND o.status='RAMASSE'
    AND o.current_holder_type='WAREHOUSE'
    AND ($2::uuid[] IS NULL OR o.id=ANY($2)) AND ($3::uuid IS NULL OR o.merchant_id=$3)
    AND ($4::text IS NULL OR strpos(o.tracking_code,upper($4))>0 OR strpos(o.phone,$4)>0)
    AND NOT EXISTS (SELECT FROM v2_dispatch_lines l WHERE l.order_id=o.id) ORDER BY o.id FOR UPDATE OF o`,
    [bon.city,input.ids??null,input.merchantId??null,input.search??null])).rows;
  for (const order of orders) {
    await db.query('INSERT INTO v2_dispatch_lines(bon_id,order_id) VALUES($1,$2)',[bon.id,order.id]);
    await db.query('UPDATE v2_orders SET agency_id=$2 WHERE id=$1',[order.id,bon.agency_id]);
    await statusEvent(db,order,'EXPEDIE',user,'OPERATIONS');
  }
  const accepted=new Set(orders.map(row=>row.id));
  await audit(db,user,'DISPATCH_ADDED','DISPATCH_BON',bon.id,{ count:orders.length,all:input.all===true });
  return { added:orders.length,rejected:[...new Set(input.ids)].filter(id=>!accepted.has(id)) };
}

async function reset(db:Transaction,user:Principal,bon:Bon,ids:string[]|null) {
  const orders=(await db.query<Order>(`SELECT o.* FROM v2_dispatch_lines l JOIN v2_orders o ON o.id=l.order_id
    WHERE l.bon_id=$1 AND ($2::uuid[] IS NULL OR o.id=ANY($2)) ORDER BY o.id FOR UPDATE OF o`,[bon.id,ids])).rows;
  if (orders.some(row=>row.status!=='EXPEDIE')) throw conflict('DISPATCH_CHANGED','Un colis a changé d’état. Vérifiez la liste avant modification.');
  for (const order of orders) {
    await db.query('DELETE FROM v2_dispatch_lines WHERE bon_id=$1 AND order_id=$2',[bon.id,order.id]);
    await db.query('UPDATE v2_orders SET agency_id=NULL WHERE id=$1',[order.id]);
    await statusEvent(db,order,'RAMASSE',user,'OPERATIONS');
  }
  return orders.length;
}

async function arrival(db:Transaction,user:Principal,agencyId:string,input:Scan,distribution:boolean,bulk=false) {
  confirmScan(input);
  const initial=await one<Order>(db,'SELECT * FROM v2_orders WHERE tracking_code=$1',[input.trackingCode]);
  if (!initial) throw new ApiError(404,'SCAN_UNKNOWN','Code de suivi inconnu.');
  const line=await one<{bon_id:string}>(db,'SELECT bon_id FROM v2_dispatch_lines WHERE order_id=$1',[initial.id]);
  if (!line) throw conflict('DISPATCH_MISSING','Ce colis ne fait partie d’aucun envoi.');
  const bon=await getBon(db,line.bon_id,true);
  const order=(await one<Order>(db,'SELECT * FROM v2_orders WHERE id=$1 FOR UPDATE',[initial.id]))!;
  if (bon.agency_id!==agencyId || order.agency_id!==agencyId) throw new ApiError(409,'SCAN_WRONG_AGENCY','Ce colis est affecté à une autre agence.',{ agencyId:bon.agency_id });
  if (await existingScan(db,order,user,input,'AGENCY',null)) return { outcome:'REPLAY',code:input.trackingCode };
  const target=distribution?'MISE_EN_DISTRIBUTION':'RECU_VILLE';
  if (order.status===target) throw conflict('SCAN_DUPLICATE','Ce colis a déjà été traité.');
  if (bon.status==='EN_PREPARATION' || (distribution ? order.status!=='RECU_VILLE' || order.current_holder_type!=='AGENCY' ||
      order.current_holder_id!==agencyId : order.status!=='EXPEDIE' || order.current_holder_type!=='WAREHOUSE')) {
    throw conflict('SCAN_WRONG_STATUS','Vérifiez le statut et le dernier détenteur du colis.');
  }
  await statusEvent(db,order,target,user,'OPERATIONS');
  await physicalEvent(db,order,user,input,'AGENCY',agencyId,null,bulk);
  if (!distribution) {
    await db.query('UPDATE v2_dispatch_lines SET received_at=clock_timestamp() WHERE bon_id=$1 AND order_id=$2',[bon.id,order.id]);
    await db.query(`UPDATE v2_dispatch_bons SET first_received_at=COALESCE(first_received_at,clock_timestamp()),
      status=CASE WHEN EXISTS(SELECT FROM v2_dispatch_lines WHERE bon_id=$1 AND received_at IS NULL) THEN 'ENVOYE' ELSE 'RECU' END WHERE id=$1`,[bon.id]);
  }
  await audit(db,user,distribution?'DISTRIBUTION_STARTED':'DISPATCH_RECEIVED','DISPATCH_BON',bon.id,{ orderId:order.id,bulk });
  return { outcome:'RECEIVED',code:input.trackingCode };
}

export function dispatchRoutes(ctx:Context) {
  const { app,pool }=ctx;
  app.get('/api/v2/dispatch',async request=>{
    const user=await ctx.user(request); check(user,'dispatch.manage');
    const query=z.object({ page,agencyId:uuid.optional() }).parse(request.query);
    const {rows}=await pool.query(`SELECT b.*,a.name AS agency,
      (SELECT COUNT(*)::int FROM v2_dispatch_lines l WHERE l.bon_id=b.id) AS count,COUNT(*) OVER()::int AS total
      FROM v2_dispatch_bons b JOIN v2_agencies a ON a.id=b.agency_id WHERE b.deleted_at IS NULL AND ($1::uuid IS NULL OR b.agency_id=$1)
      ORDER BY b.created_at DESC,b.id LIMIT 50 OFFSET $2`,[query.agencyId??null,(query.page-1)*50]);
    return { rows,total:rows[0]?.total??0,page:query.page };
  });
  app.post('/api/v2/dispatch',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'dispatch.manage');
    const input=z.object({ agencyId:uuid,city:text(80) }).strict().parse(request.body);
    const bon=await transaction(pool,async db=>{
      const agency=await activeAgency(db,input.agencyId);
      if (normalizeCity(input.city)!==agency.city) throw conflict('AGENCY_CITY','L’agence doit correspondre à la ville choisie.');
      const row=await one<Bon>(db,'INSERT INTO v2_dispatch_bons(agency_id,city,created_by) VALUES($1,$2,$3) RETURNING *',[agency.id,agency.city,user.id]);
      await audit(db,user,'DISPATCH_CREATED','DISPATCH_BON',row!.id);
      return row;
    });
    return reply.code(201).send(bon);
  });
  app.get('/api/v2/dispatch/:id',async request=>{
    const user=await ctx.user(request); check(user,'dispatch.manage');
    const bon=await getBon(pool,param(request));
    const query=z.object({page,search:text(120).optional(),merchantId:uuid.optional()}).parse(request.query);
    const [candidates,items]=await Promise.all([
      pool.query(`SELECT o.id,o.tracking_code,o.phone,m.name AS merchant,COUNT(*) OVER()::int AS total FROM v2_orders o JOIN v2_merchants m ON m.id=o.merchant_id
        WHERE o.city=$1 AND o.status='RAMASSE' AND o.current_holder_type='WAREHOUSE' AND ($2::uuid IS NULL OR o.merchant_id=$2)
        AND ($3::text IS NULL OR strpos(o.tracking_code,upper($3))>0 OR strpos(o.phone,$3)>0)
        AND NOT EXISTS (SELECT FROM v2_dispatch_lines l WHERE l.order_id=o.id)
        ORDER BY o.status_updated_at DESC,o.id LIMIT 50 OFFSET $4`,[bon.city,query.merchantId??null,query.search??null,(query.page-1)*50]),
      pool.query(`SELECT o.id,o.tracking_code,o.status,l.received_at,m.name AS merchant FROM v2_dispatch_lines l
        JOIN v2_orders o ON o.id=l.order_id JOIN v2_merchants m ON m.id=o.merchant_id WHERE l.bon_id=$1 ORDER BY o.tracking_code`,[bon.id]),
    ]);
    return { bon,items:items.rows,candidates:candidates.rows,total:candidates.rows[0]?.total??0,page:query.page };
  });
  app.post('/api/v2/dispatch/:id/add',async request=>{
    const user=await ctx.user(request); check(user,'dispatch.manage');
    const input=selection.parse(request.body),id=param(request);
    return transaction(pool,async db=>add(db,await getBon(db,id,true),user,input));
  });
  app.post('/api/v2/dispatch/:id/scan',async request=>{
    const user=await ctx.user(request); check(user,'dispatch.manage');
    const input=scanInput.parse(request.body),id=param(request);
    confirmScan(input);
    return transaction(pool,async db=>{
      const bon=await getBon(db,id,true);
      const order=await one<Order>(db,'SELECT * FROM v2_orders WHERE tracking_code=$1 FOR UPDATE',[input.trackingCode]);
      if (!order) throw new ApiError(404,'SCAN_UNKNOWN','Code de suivi inconnu.');
      const prior=await one<{entity_id:string;actor_id:string;metadata:{orderId:string;method:string}}>(db,`SELECT entity_id,actor_id,metadata FROM v2_audit_events
        WHERE action='DISPATCH_SCANNED' AND metadata->>'requestKey'=$1 LIMIT 1`,[input.requestKey]);
      if (prior) {
        if (prior.entity_id===id && prior.actor_id===user.id && prior.metadata.orderId===order.id && prior.metadata.method===input.method) {
          return { outcome:'REPLAY',code:input.trackingCode };
        }
        throw conflict('SCAN_KEY_REUSED','Cette clé de scan est déjà utilisée.');
      }
      if (order.city!==bon.city) throw conflict('SCAN_WRONG_AGENCY','La ville du colis ne correspond pas à l’agence choisie.');
      if (await one(db,'SELECT 1 FROM v2_dispatch_lines WHERE order_id=$1',[order.id])) throw conflict('SCAN_DUPLICATE','Ce colis est déjà dans un bon.');
      const result=await add(db,bon,user,{ ids:[order.id] });
      if (!result.added) throw conflict('SCAN_WRONG_STATUS','Colis non disponible au ramassage.');
      await audit(db,user,'DISPATCH_SCANNED','DISPATCH_BON',id,{ orderId:order.id,method:input.method,requestKey:input.requestKey });
      return { outcome:'RECEIVED',code:input.trackingCode };
    });
  });
  app.post('/api/v2/dispatch/:id/state',async request=>{
    const user=await ctx.user(request); check(user,'dispatch.manage');
    const id=param(request);
    const input=z.object({ action:z.enum(['SEND','REOPEN','DELETE','REMOVE']),ids:z.array(uuid).min(1).max(5000).optional(),
      confirmed:z.literal(true).optional() }).strict().parse(request.body);
    return transaction(pool,async db=>{
      const bon=await getBon(db,id,true);
      if (bon.first_received_at || bon.status==='RECU') throw conflict('DISPATCH_LOCKED','Ce bon est verrouillé depuis la première réception.');
      if (input.action==='SEND' && bon.status==='EN_PREPARATION') {
        if (!await one(db,'SELECT 1 FROM v2_dispatch_lines WHERE bon_id=$1 LIMIT 1',[id])) throw conflict('BON_EMPTY','Ajoutez des colis avant l’envoi.');
        await db.query("UPDATE v2_dispatch_bons SET status='ENVOYE' WHERE id=$1",[id]);
      } else if (input.action==='REOPEN' && bon.status==='ENVOYE') {
        await db.query("UPDATE v2_dispatch_bons SET status='EN_PREPARATION' WHERE id=$1",[id]);
      } else if (input.action==='DELETE' && input.confirmed) {
        await reset(db,user,bon,null);
        await db.query('UPDATE v2_dispatch_bons SET deleted_at=now() WHERE id=$1',[id]);
      } else if (input.action==='REMOVE' && bon.status==='EN_PREPARATION' && input.ids) {
        await reset(db,user,bon,input.ids);
      } else throw conflict('BON_STATUS','Action indisponible dans cet état.');
      await audit(db,user,'DISPATCH_'+input.action,'DISPATCH_BON',id);
      return { action:input.action };
    });
  });
  app.get('/api/v2/dispatch/:id/export',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'dispatch.manage');
    const bon=await getBon(pool,param(request));
    const agency=await activeAgency(pool,bon.agency_id);
    const rows=(await pool.query(`SELECT o.* FROM v2_dispatch_lines l JOIN v2_orders o ON o.id=l.order_id WHERE l.bon_id=$1 ORDER BY o.tracking_code`,[bon.id])).rows;
    return sendFile(reply,'envoi-'+bon.id+'.xlsx',xlsxMime,await workbook(agency.dispatch_excel_headers,rows.map(row=>exportValues(row as Parameters<typeof exportValues>[0]))));
  });
  async function receive(request:FastifyRequest,distribution:boolean) {
    const user=await ctx.user(request); check(user,'dispatch.manage');
    const id=param(request);
    const input=scanInput.or(z.object({ codes:z.array(code).min(1).max(1000),confirmed:z.literal(true) }).strict()).parse(request.body);
    if ('trackingCode' in input) return transaction(pool,db=>arrival(db,user,id,input,distribution));
    const results=[];
    for (const trackingCode of new Set(input.codes)) {
      try {
        results.push(await transaction(pool,db=>arrival(db,user,id,{trackingCode,method:'MANUAL',confirmed:true,requestKey:randomUUID()},distribution,true)));
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        results.push({ code:trackingCode,outcome:error.code,message:error.message });
      }
    }
    return { results };
  }
  app.post('/api/v2/dispatch/agencies/:id/arrival',request=>receive(request,false));
  app.post('/api/v2/dispatch/agencies/:id/distribution',request=>receive(request,true));
}
