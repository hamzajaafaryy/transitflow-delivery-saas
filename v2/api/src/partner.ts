import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { lock, one, transaction, type Transaction } from './db.js';
import { activeAgency, lastMile, type Order, type Status } from './domain.js';
import { reconcileMoney } from './finance.js';
import { ApiError, code, conflict, date, forbidden, page, param, text, uuid } from './http.js';
import { clearNotice, notify } from './notifications.js';
import { digest, safeEqual, seal, unseal } from './security/crypto.js';
import { audit, type Context } from './security/session.js';

const inputEvent=z.object({
  id:z.string().regex(/^[A-Za-z0-9_.:-]{1,140}$/),
  trackingCode:code, externalStatus:z.string().min(1).max(100).regex(/^[^\r\n\x00-\x1f]+$/), occurredAt:date,
}).strict();
const base='/api/v2/developer/partners';

async function replay(db:Transaction,order:Order,eventKey:string) {
  const current=await one<{status:Status;occurred_at:Date;delivered_at:Date|null}>(db,`WITH timeline AS (
    SELECT status,occurred_at,CASE WHEN source='CORRECTION' THEN 3 ELSE 1 END AS precedence,id FROM v2_order_events
    WHERE order_id=$1 AND source<>'PARTNER'
    UNION ALL
    SELECT mapped_status,occurred_at,2,id FROM v2_partner_events WHERE order_id=$1 AND mapped_status IS NOT NULL
  ), exchanges AS (
    SELECT MIN(occurred_at) AS delivered FROM timeline WHERE status='LIVRE'
  ), changes AS (
    SELECT status,occurred_at,precedence,id,LAG(status) OVER(ORDER BY occurred_at,precedence,id) AS previous
    FROM timeline WHERE NOT $2 OR (SELECT delivered FROM exchanges) IS NULL OR occurred_at<=(SELECT delivered FROM exchanges)
  )
  SELECT status,occurred_at,CASE WHEN status='LIVRE' THEN occurred_at END AS delivered_at
  FROM changes WHERE status IS DISTINCT FROM previous ORDER BY occurred_at DESC,precedence DESC,id DESC LIMIT 1`,[order.id,order.is_exchange]);
  if (!current) return;
  if (order.is_exchange && order.status==='LIVRE' && current.status!=='LIVRE') return;
  if (order.status!==current.status || +order.status_updated_at!==+current.occurred_at) {
    await db.query('UPDATE v2_orders SET status=$2,status_updated_at=$3,delivered_at=$4 WHERE id=$1',
      [order.id,current.status,current.occurred_at,current.delivered_at]);
    if (order.status!==current.status) await reconcileMoney(db,order,current.status,eventKey);
  }
}

async function agencyReplay(db:Transaction,agencyId:string,status:string|null,key:string) {
  await db.query(`UPDATE v2_partner_events e SET mapped_status=(
    SELECT m.internal_status FROM v2_partner_mappings m WHERE m.agency_id=e.agency_id AND m.external_status=e.external_status)
    WHERE e.agency_id=$1 AND ($2::text IS NULL OR e.external_status=$2)`,[agencyId,status]);
  const orders=(await db.query<Order>(`SELECT o.* FROM v2_orders o WHERE EXISTS(SELECT FROM v2_partner_events e
    WHERE e.order_id=o.id AND e.agency_id=$1 AND ($2::text IS NULL OR e.external_status=$2))
    ORDER BY o.merchant_id,o.id FOR UPDATE OF o`,[agencyId,status])).rows;
  for (const order of orders) await replay(db,order,key+':'+order.id);
  return orders.length;
}

export function partnerRoutes(ctx:Context) {
  const { app,pool,config }=ctx;
  app.post('/api/v2/partner/:id/events',{ config:{ rateLimit:{max:2400,timeWindow:'1 minute'} } },async (request,reply)=>{
    const agencyId=param(request),input=inputEvent.parse(request.body);
    const timestamp=request.headers['x-tf-timestamp'],signature=request.headers['x-tf-signature'];
    const reject=()=>new ApiError(401,'PARTNER_AUTH','Authentification partenaire invalide.');
    if (typeof timestamp!=='string'||!/^\d{10}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300 ||
      typeof signature!=='string'||!/^sha256=[0-9a-f]{64}$/.test(signature)) throw reject();
    if (+new Date(input.occurredAt)>Date.now()+60_000) throw new ApiError(422,'FUTURE_EVENT','Horodatage de statut dans le futur.');
    const result=await transaction(pool,async db=>{
      await lock(db,'partner',agencyId);
      const connection=await one<{secret_encrypted:string}>(db,`SELECT c.secret_encrypted FROM v2_partner_connections c JOIN v2_agencies a ON a.id=c.agency_id
        WHERE c.agency_id=$1 AND c.active AND a.active`,[agencyId]);
      if (!connection) throw reject();
      const message=[timestamp,input.id,input.trackingCode,input.externalStatus,input.occurredAt].join('\n');
      const expected=createHmac('sha256',unseal(connection.secret_encrypted,config.dataKey,'partner:'+agencyId)).update(message).digest();
      if (!safeEqual(expected,Buffer.from(signature.slice(7),'hex'))) throw reject();
      const order=await one<Order>(db,`SELECT * FROM v2_orders WHERE tracking_code=$1 AND agency_id=$2
        AND EXISTS(SELECT FROM v2_dispatch_lines l JOIN v2_dispatch_bons b ON b.id=l.bon_id
          WHERE l.order_id=v2_orders.id AND b.status IN ('ENVOYE','RECU') AND b.deleted_at IS NULL) FOR UPDATE`,[input.trackingCode,agencyId]);
      if (!order) throw new ApiError(404,'ORDER_NOT_FOUND','Commande introuvable pour cette agence.');
      const previous=await one<{order_id:string;external_status:string;occurred_at:Date;mapped_status:string|null}>(db,`SELECT order_id,external_status,occurred_at,mapped_status
        FROM v2_partner_events WHERE agency_id=$1 AND event_key=$2`,[agencyId,input.id]);
      if (previous) {
        if (previous.order_id!==order.id || previous.external_status!==input.externalStatus || +previous.occurred_at!==+new Date(input.occurredAt)) {
          throw conflict('EVENT_KEY_REUSED','Identifiant événement déjà utilisé.');
        }
        return { outcome:'REPLAY',mapped:previous.mapped_status!==null };
      }
      const mapping=await one<{internal_status:Status}>(db,'SELECT internal_status FROM v2_partner_mappings WHERE agency_id=$1 AND external_status=$2',
        [agencyId,input.externalStatus]);
      await db.query(`INSERT INTO v2_partner_events(agency_id,event_key,order_id,external_status,occurred_at,mapped_status)
        VALUES($1,$2,$3,$4,$5,$6)`,[agencyId,input.id,order.id,input.externalStatus,input.occurredAt,mapping?.internal_status??null]);
      await db.query('UPDATE v2_partner_connections SET last_seen_at=clock_timestamp(),last_error_at=NULL WHERE agency_id=$1',[agencyId]);
      await clearNotice(db,'partner-outage:'+agencyId);
      if (mapping) await replay(db,order,'partner:'+agencyId+':'+digest(input.id));
      return { outcome:mapping?'APPLIED':'UNMAPPED',mapped:Boolean(mapping) };
    });
    return reply.code(result.mapped?200:202).send(result);
  });

  app.get(base,async request=>{
    const user=await ctx.user(request); if (user.role!=='DEVELOPER') throw forbidden();
    const {rows}=await pool.query(`SELECT a.id,a.name,a.city,a.active,c.active AS connected,c.last_seen_at,c.last_error_at,
      (SELECT COUNT(*)::int FROM v2_partner_events e WHERE e.agency_id=a.id AND e.mapped_status IS NULL) AS unmapped
      FROM v2_agencies a LEFT JOIN v2_partner_connections c ON c.agency_id=a.id ORDER BY a.name`);
    return { rows };
  });
  app.get(base+'/:id/events',async request=>{
    const user=await ctx.user(request); if (user.role!=='DEVELOPER') throw forbidden();
    const {page:current,unmapped}=z.object({page,unmapped:z.enum(['1','0']).default('1')}).parse(request.query);
    const id=param(request);
    const [events,mappings]=await Promise.all([
      pool.query(`SELECT id,external_status,mapped_status,occurred_at,created_at FROM v2_partner_events
        WHERE agency_id=$1 AND (NOT $2 OR mapped_status IS NULL) ORDER BY occurred_at DESC,id DESC LIMIT 50 OFFSET $3`,
        [id,unmapped==='1',(current-1)*50]),
      pool.query('SELECT external_status,internal_status FROM v2_partner_mappings WHERE agency_id=$1 ORDER BY external_status',[id]),
    ]);
    return { rows:events.rows,mappings:mappings.rows };
  });
  app.put(base+'/:id/secret',async request=>{
    const user=await ctx.user(request); if (user.role!=='DEVELOPER') throw forbidden();
    const id=param(request);
    const input=z.object({secret:z.string().min(32).max(256)}).strict().parse(request.body);
    await transaction(pool,async db=>{
      await activeAgency(db,id);
      await lock(db,'partner',id);
      await db.query(`INSERT INTO v2_partner_connections(agency_id,secret_encrypted,last_seen_at) VALUES($1,$2,now())
        ON CONFLICT(agency_id) DO UPDATE SET secret_encrypted=excluded.secret_encrypted,active=true,last_seen_at=now(),last_error_at=NULL`,
        [id,seal(input.secret,config.dataKey,'partner:'+id)]);
      await audit(db,user,'PARTNER_SECRET_ROTATED','AGENCY',id);
    });
    return { configured:true };
  });
  app.put(base+'/:id/mapping',async request=>{
    const user=await ctx.user(request); if (user.role!=='DEVELOPER') throw forbidden();
    const id=param(request);
    const input=z.object({externalStatus:text(100),status:lastMile,reason:text(250)}).strict().parse(request.body);
    return transaction(pool,async db=>{
      await activeAgency(db,id);
      await lock(db,'partner',id);
      await db.query(`INSERT INTO v2_partner_mappings(agency_id,external_status,internal_status) VALUES($1,$2,$3)
        ON CONFLICT(agency_id,external_status) DO UPDATE SET internal_status=excluded.internal_status`,[id,input.externalStatus,input.status]);
      const entry=await one<{id:string}>(db,`INSERT INTO v2_audit_events(actor_id,action,entity_type,entity_id,metadata)
        VALUES($1,'PARTNER_MAPPING_REPLAY','AGENCY',$2,$3) RETURNING id`,[user.id,id,input]);
      const affected=await agencyReplay(db,id,input.externalStatus,'mapping:'+entry!.id);
      return { affected };
    });
  });
  app.post(base+'/:id/resync',async request=>{
    const user=await ctx.user(request); if (user.role!=='DEVELOPER') throw forbidden();
    const id=param(request),{reason}=z.object({reason:text(250)}).strict().parse(request.body);
    return transaction(pool,async db=>{
      await lock(db,'partner',id);
      const entry=await one<{id:string}>(db,`INSERT INTO v2_audit_events(actor_id,action,entity_type,entity_id,metadata)
        VALUES($1,'PARTNER_MANUAL_REPLAY','AGENCY',$2,$3) RETURNING id`,[user.id,id,{reason}]);
      return { affected:await agencyReplay(db,id,null,'resync:'+entry!.id) };
    });
  });
}

export async function flagStalePartners(db:Transaction) {
  const stale=(await db.query<{agency_id:string}>(`UPDATE v2_partner_connections SET last_error_at=clock_timestamp()
    WHERE active AND last_error_at IS NULL AND last_seen_at<now()-interval '24 hours' RETURNING agency_id`)).rows;
  if (!stale.length) return;
  const {rows}=await db.query<{id:string}>("SELECT id FROM v2_users WHERE active AND presence<>'ABSENTE' AND role IN ('ADMIN','DEVELOPER')");
  for (const row of stale) await notify(db,rows.map(u=>u.id),'partner-outage:'+row.agency_id,'Aucune mise à jour partenaire reçue depuis 24 heures.',row.agency_id);
}
