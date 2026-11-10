import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, transaction, type Transaction } from './db.js';
import { filterWindow, mainWarehouse, normalizeCity, packaging, scanInput, statusEvent, statuses, type Order, type Scan, type Status } from './domain.js';
import { localDate, pdfMime, ticketPdf, workbook, xlsxMime } from './documents.js';
import { reconcileMoney } from './finance.js';
import { ApiError, centimes, conflict, forbidden, missing, page, param, sendFile, text, uuid } from './http.js';
import type { Principal } from './security/authorization.js';
import { audit, check, ownScope, type Context } from './security/session.js';
import { deductStock, releaseStock, reserveStock, stockLock } from './stock.js';

const searchFilter=z.object({
  ...filterWindow, page, merchantId:uuid.optional(), agencyId:uuid.optional(), city:text(80).optional(), status:z.enum(statuses).optional(),
});
const orderColumns=`o.id,o.tracking_code,o.recipient,o.phone,o.address,o.city,o.status,o.status_updated_at,o.created_at,
  o.merchant_id,m.name AS merchant,o.agency_id,a.name AS agency,o.cod_centimes,o.source,o.comment,o.merchandise,
  o.quantity,o.can_open,o.is_exchange,o.current_holder_type,o.current_holder_id,o.holder_updated_at,o.delivered_at,o.packaging_kind`;
const joins='FROM v2_orders o JOIN v2_merchants m ON m.id=o.merchant_id LEFT JOIN v2_agencies a ON a.id=o.agency_id';
export const exportHeaders=['CODE SUIVI','DESTINATAIRE','TELEPHONE','ADRESSE','PRIX','VILLE','COMMENTAIRE','MARCHANDISE','QTY','PEUT OUVRIR','COLIS REMPLACER'];
type ExportOrder={ tracking_code:string; recipient:string; phone:string; address:string; cod_centimes:string; city:string;
  comment:string; merchandise:string; quantity:number; can_open:boolean; is_exchange:boolean };
export function exportValues(row: ExportOrder) {
  return [row.tracking_code,row.recipient,row.phone,row.address,(Number(row.cod_centimes)/100).toFixed(2),row.city,row.comment,
    row.merchandise,row.quantity,row.can_open?'OUI':'NON',row.is_exchange?'OUI':'NON'];
}

function scopedFilters(user: Principal, request: FastifyRequest) {
  const query=searchFilter.parse(request.query);
  if (user.merchantId && query.merchantId && user.merchantId!==query.merchantId) throw forbidden();
  if (user.agencyId && query.agencyId && user.agencyId!==query.agencyId) throw forbidden();
  const args=[user.merchantId??query.merchantId??null,user.agencyId??query.agencyId??null,query.city?normalizeCity(query.city):null,
    query.status??null,query.from??null,query.to??null,query.search??null,user.role==='PARTNER_AGENCY'];
  const where=`WHERE ($1::uuid IS NULL OR o.merchant_id=$1) AND
      ($2::uuid IS NULL OR (CASE WHEN $8 THEN o.current_holder_id=$2 AND o.current_holder_type='AGENCY' ELSE o.agency_id=$2 END))
      AND ($3::text IS NULL OR o.city=$3) AND ($4::text IS NULL OR o.status=$4)
      AND ($5::timestamptz IS NULL OR o.status_updated_at>=$5) AND ($6::timestamptz IS NULL OR o.status_updated_at<$6)
      AND ($7::text IS NULL OR strpos(lower(o.tracking_code),lower($7))>0 OR (NOT $8 AND strpos(o.phone,$7)>0))`;
  return { query,args,where };
}

const creation=z.object({
  merchantId:uuid.optional(),source:z.enum(['STOCK','EXTERNAL']),recipient:text(100),phone:z.string().trim().regex(/^[+0-9 ()-]{8,24}$/),
  address:text(250),city:text(80),codCentimes:centimes,comment:z.string().trim().max(250).default(''),merchandise:z.string().trim().max(200).default(''),
  quantity:z.number().int().min(1).max(1000).default(1),canOpen:z.boolean().default(false),isExchange:z.boolean().default(false),
  items:z.array(z.object({ productId:uuid,quantity:z.number().int().min(1).max(1000) }).strict()).max(100).default([]),
}).strict().refine(input => (input.source==='STOCK')===Boolean(input.items.length))
  .refine(input => new Set(input.items.map(item=>item.productId)).size===input.items.length);

export async function existingScan(db: Transaction, order: Order, user: Principal, input: Scan, targetType: string, bonId: string|null) {
  const prior=await one<{order_id:string;actor_id:string;method:string;to_holder_type:string;bon_id:string|null}>(db,
    'SELECT order_id,actor_id,method,to_holder_type,bon_id FROM v2_scan_events WHERE request_key=$1',[input.requestKey]);
  if (!prior) return false;
  if (prior.order_id===order.id && prior.actor_id===user.id && prior.method===input.method &&
      prior.to_holder_type===targetType && prior.bon_id===bonId) return true;
  throw conflict('SCAN_KEY_REUSED','Cette clé de scan a déjà été utilisée pour une autre opération.');
}

export function confirmScan(input: Scan) {
  if (input.method==='MANUAL' && !input.confirmed) {
    throw new ApiError(422,'SCAN_CONFIRM_MANUAL','Confirmez la réception sans scan physique.');
  }
}

export async function physicalEvent(db: Transaction, order: Order, user: Principal, input: Scan, holder: string, holderId: string,
  bonId: string|null = null, bulk=false) {
  await db.query('UPDATE v2_orders SET current_holder_type=$2,current_holder_id=$3,holder_updated_at=clock_timestamp() WHERE id=$1',[order.id,holder,holderId]);
  await db.query(`INSERT INTO v2_scan_events(order_id,bon_id,actor_id,method,from_holder_type,from_holder_id,to_holder_type,to_holder_id,request_key,evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[order.id,bonId,user.id,input.method,order.current_holder_type,order.current_holder_id,
    holder,holderId,input.requestKey,bulk?'STAFF_BULK':input.method==='CAMERA'?'CAMERA_DECODED':input.method==='BARCODE'?'USB_SERIAL':'UNVERIFIED']);
  await audit(db,user,'HOLDER_CHANGED','ORDER',order.id,{ method:input.method, holder, holderId, bulk });
}

async function collect(db: Transaction, user: Principal, input: Scan, bulk=false) {
  confirmScan(input);
  const initial=await one<Order>(db,'SELECT * FROM v2_orders WHERE tracking_code=$1',[input.trackingCode]);
  if (!initial) throw new ApiError(404,'SCAN_UNKNOWN','Code de suivi inconnu.');
  if (initial.source==='STOCK') await stockLock(db,initial.merchant_id);
  const order=(await one<Order>(db,'SELECT * FROM v2_orders WHERE id=$1 FOR UPDATE',[initial.id]))!;
  if (await existingScan(db,order,user,input,'WAREHOUSE',null)) return { outcome:'REPLAY',code:order.tracking_code };
  if (order.status==='RAMASSE') throw conflict('SCAN_DUPLICATE','Colis déjà ramassé.');
  if (order.status!=='ATTENTE_RAMASSAGE') throw conflict('SCAN_WRONG_STATUS','Cette commande ne peut pas être ramassée.');
  if (order.source==='STOCK') await deductStock(db,order,user);
  const warehouse=await mainWarehouse(db);
  await statusEvent(db,order,'RAMASSE',user,'OPERATIONS');
  await physicalEvent(db,order,user,input,'WAREHOUSE',warehouse,null,bulk);
  return { outcome:'RECEIVED',code:order.tracking_code };
}

export function orderRoutes(ctx: Context) {
  const { app,pool }=ctx;
  app.get('/api/v2/orders',async request=>{
    const user=await ctx.user(request); check(user,'orders.read',ownScope(user));
    const { query,args,where }=scopedFilters(user,request);
    const columns=user.agencyId
      ? 'o.id,o.tracking_code,o.city,o.status,o.status_updated_at,o.current_holder_type,o.holder_updated_at,a.name AS agency'
      : orderColumns;
    const rows=(await pool.query(`SELECT ${columns},COUNT(*) OVER()::int AS total ${joins} ${where}
      ORDER BY o.status_updated_at DESC,o.id DESC LIMIT 50 OFFSET $9`,[...args,(query.page-1)*50])).rows;
    return { rows,total:rows[0]?.total??0,page:query.page };
  });
  app.get('/api/v2/orders/export',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'orders.export',ownScope(user));
    const { args,where }=scopedFilters(user,request);
    const rows=(await pool.query<ExportOrder>(`SELECT ${orderColumns} ${joins} ${where} ORDER BY o.status_updated_at DESC,o.id DESC`,args)).rows;
    return sendFile(reply,'commandes-transitflow.xlsx',xlsxMime,await workbook(exportHeaders,rows.map(exportValues)));
  });
  app.get('/api/v2/orders/:id',async request=>{
    const user=await ctx.user(request);
    const id=param(request);
    const scope=ownScope(user); check(user,'orders.read',scope);
    const columns=user.agencyId
      ? 'o.id,o.tracking_code,o.city,o.status,o.status_updated_at,o.current_holder_type,o.holder_updated_at,a.name AS agency'
      : orderColumns;
    const row=await one(pool,`SELECT ${columns} ${joins} WHERE o.id=$1 AND ($2::uuid IS NULL OR o.merchant_id=$2)
      AND ($3::uuid IS NULL OR (o.current_holder_type='AGENCY' AND o.current_holder_id=$3))`,[id,user.merchantId??null,user.agencyId??null]);
    if (!row) throw missing('Commande introuvable.');
    const history=(await pool.query(`SELECT status,occurred_at,source FROM (SELECT status,occurred_at,source FROM v2_order_events WHERE order_id=$1
      UNION ALL SELECT mapped_status,occurred_at,'PARTNER' FROM v2_partner_events WHERE order_id=$1 AND mapped_status IS NOT NULL) h ORDER BY occurred_at DESC LIMIT 100`,[id])).rows;
    return { order:row,history };
  });
  app.get('/api/v2/agency-stock/export',async (request,reply)=>{
    const user=await ctx.user(request);
    check(user,'orders.read',ownScope(user));
    if (!user.agencyId) throw forbidden();
    const { args,where }=scopedFilters(user,request);
    const rows=(await pool.query(`SELECT o.tracking_code,o.status,o.current_holder_type,o.holder_updated_at,a.name AS agency
      ${joins} ${where} ORDER BY o.status_updated_at DESC,o.id DESC`,args)).rows;
    const values=rows.map(row=>[row.tracking_code,row.status,row.current_holder_type,row.holder_updated_at?localDate(row.holder_updated_at):'',row.agency]);
    return sendFile(reply,'stock-colis-agence.xlsx',xlsxMime,await workbook(['Code Suivi','Statut','Dernier Scan','Date','Agence'],values));
  });
  app.post('/api/v2/orders',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'orders.create',ownScope(user));
    const input=creation.parse(request.body);
    if (user.merchantId && input.merchantId && user.merchantId!==input.merchantId) throw forbidden();
    const merchantId=user.merchantId??input.merchantId;
    if (!merchantId) throw new ApiError(422,'MERCHANT_REQUIRED','Choisissez un marchand.');
    const result=await transaction(pool,async db=>{
      if (input.source==='STOCK') await stockLock(db,merchantId);
      const city=normalizeCity(input.city);
      const merchant=await one<{refused_fee_centimes:string;delivery_fee_centimes:string}>(db,`SELECT m.refused_fee_centimes,
        COALESCE(r.delivery_fee_centimes,0) AS delivery_fee_centimes FROM v2_merchants m
        LEFT JOIN v2_merchant_rates r ON r.merchant_id=m.id AND r.city=$2 WHERE m.id=$1 AND m.active`,[merchantId,city]);
      if (!merchant) throw missing('Marchand introuvable.');
      const ids=input.items.map(item=>item.productId);
      if (ids.length) {
        const products=await db.query('SELECT id FROM v2_stock_products WHERE merchant_id=$1 AND id=ANY($2::uuid[])',[merchantId,ids]);
        if (products.rowCount!==ids.length) throw forbidden();
      }
      const trackingCode='BOXSH'+randomBytes(6).toString('hex').toUpperCase();
      const status=input.source==='STOCK'?'MANQUE_STOCK':'ATTENTE_RAMASSAGE';
      const holderId=input.source==='STOCK'?await mainWarehouse(db):merchantId;
      const row=await one<Order>(db,`INSERT INTO v2_orders(tracking_code,merchant_id,source,status,recipient,phone,address,city,cod_centimes,
        comment,merchandise,quantity,can_open,is_exchange,current_holder_type,current_holder_id,holder_updated_at,delivery_fee_centimes,refused_fee_centimes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),$17,$18) RETURNING *`,
        [trackingCode,merchantId,input.source,status,input.recipient,input.phone,input.address,city,input.codCentimes,input.comment,input.merchandise,
        input.source==='STOCK'?input.items.reduce((n,item)=>n+item.quantity,0):input.quantity,input.canOpen,input.isExchange,
        input.source==='STOCK'?'WAREHOUSE':'MERCHANT',holderId,merchant.delivery_fee_centimes,merchant.refused_fee_centimes]);
      if (!row) throw new Error('Order insertion failed');
      await db.query("INSERT INTO v2_order_events(order_id,status,source,occurred_at,actor_id) VALUES($1,$2,'OPERATIONS',$3,$4)",
        [row.id,row.status,row.status_updated_at,user.id]);
      for (const item of input.items) await db.query('INSERT INTO v2_stock_order_items(order_id,product_id,quantity) VALUES($1,$2,$3)',[row.id,item.productId,item.quantity]);
      if (input.items.length && await reserveStock(db,row)) await statusEvent(db,row,'ATTENTE_RAMASSAGE',user,'OPERATIONS');
      await audit(db,user,'ORDER_CREATED','ORDER',row.id,{ source:input.source });
      return one(db,'SELECT id,tracking_code,status FROM v2_orders WHERE id=$1',[row.id]);
    });
    return reply.code(201).send(result);
  });
  app.post('/api/v2/orders/:id/correct',async request=>{
    const user=await ctx.user(request); check(user,'orders.status_override');
    const id=param(request);
    const input=z.object({ status:z.enum(statuses),reason:text(400),returnAuthorized:z.boolean().optional() }).strict().parse(request.body);
    return transaction(pool,async db=>{
      const initial=await one<Order>(db,'SELECT * FROM v2_orders WHERE id=$1',[id]);
      if (!initial) throw missing();
      if (initial.source==='STOCK') await stockLock(db,initial.merchant_id);
      const order=(await one<Order>(db,'SELECT * FROM v2_orders WHERE id=$1 FOR UPDATE',[id]))!;
      if (input.status!==order.status && ['MANQUE_STOCK','ATTENTE_RAMASSAGE','RAMASSE','EXPEDIE'].includes(input.status)) {
        throw conflict('PHYSICAL_WORKFLOW_REQUIRED','Utilisez le module Stock, Ramassage ou Envoi pour cette étape.');
      }
      if (order.is_exchange && order.status==='LIVRE' && input.status!=='LIVRE') {
        throw conflict('EXCHANGE_DELIVERED','Le statut livré d’un échange est conservé.');
      }
      if (order.source==='STOCK' && input.status==='ANNULE' && ['MANQUE_STOCK','ATTENTE_RAMASSAGE'].includes(order.status)) await releaseStock(db,order.id);
      await statusEvent(db,order,input.status,user,'CORRECTION',new Date(),input.reason);
      if (input.returnAuthorized!==undefined) await db.query('UPDATE v2_orders SET return_authorized=$2 WHERE id=$1',[id,input.returnAuthorized]);
      if (order.status!==input.status) await reconcileMoney(db,order,input.status,'correction:'+randomUUID());
      await audit(db,user,'ORDER_STATUS_CORRECTED','ORDER',id,{ from:order.status,to:input.status,reason:input.reason,returnAuthorized:input.returnAuthorized });
      return { id,status:input.status };
    });
  });
  app.post('/api/v2/orders/packaging',async request=>{
    const user=await ctx.user(request); check(user,'stock.manage');
    const input=z.object({ ids:z.array(uuid).min(1).max(1000),kind:packaging.nullable(),companyPacked:z.boolean(),
      heavyOverride:text(250).optional(),overrideCentimes:centimes.optional() }).strict()
      .refine(x=>(!x.kind&&!x.overrideCentimes)||x.companyPacked)
      .refine(x=>x.overrideCentimes===undefined||Boolean(x.heavyOverride)).parse(request.body);
    return transaction(pool,async db=>{
      const rows=(await db.query<Order>('SELECT * FROM v2_orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[input.ids])).rows;
      if (rows.length!==new Set(input.ids).size) throw missing();
      for (const order of rows) {
        if (!['MANQUE_STOCK','ATTENTE_RAMASSAGE','RAMASSE'].includes(order.status)) throw conflict('PACKAGING_LOCKED','Frais figés après la préparation.');
        const fee=input.kind && await one<{centimes:string}>(db,'SELECT centimes FROM v2_packaging_rates WHERE merchant_id=$1 AND kind=$2',[order.merchant_id,input.kind]);
        await db.query('UPDATE v2_orders SET company_packed=$2,packaging_kind=$3,packaging_centimes=$4 WHERE id=$1',
          [order.id,input.companyPacked,input.kind,input.overrideCentimes??(fee?fee.centimes:0)]);
        await audit(db,user,'PACKAGING_SET','ORDER',order.id,{ kind:input.kind,companyPacked:input.companyPacked,reason:input.heavyOverride,override:input.overrideCentimes });
      }
      return { updated:rows.length };
    });
  });
  app.post('/api/v2/orders/collect',async request=>{
    const user=await ctx.user(request); check(user,'dispatch.manage');
    const input=scanInput.parse(request.body);
    return transaction(pool,db=>collect(db,user,input));
  });
  app.post('/api/v2/tickets',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'orders.read',ownScope(user));
    if (user.agencyId) throw forbidden();
    const { ids }=z.object({ ids:z.array(uuid).min(1).max(1000) }).strict().parse(request.body);
    if (new Set(ids).size!==ids.length) throw new ApiError(422,'DUPLICATE_SELECTION','Retirez les commandes en double.');
    const batch=await transaction(pool,async db=>{
      const eligible=await db.query(`SELECT id FROM v2_orders WHERE id=ANY($1::uuid[]) AND status<>'MANQUE_STOCK'
        AND ($2::uuid IS NULL OR merchant_id=$2) FOR SHARE`,[ids,user.merchantId??null]);
      if (eligible.rowCount!==ids.length) throw conflict('TICKET_BLOCKED','Au moins une commande est indisponible ou manque de stock.');
      const row=await one<{id:string}>(db,'INSERT INTO v2_ticket_batches(created_by) VALUES($1) RETURNING id',[user.id]);
      await db.query(`INSERT INTO v2_ticket_batch_lines(batch_id,order_id,position)
        SELECT $1,id,ordinal FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id,ordinal)`,[row!.id,ids]);
      return row;
    });
    return reply.code(201).send(batch);
  });
  app.get('/api/v2/tickets/:id/pdf',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'orders.read',ownScope(user));
    if (user.agencyId) throw forbidden();
    const rows=(await pool.query(`SELECT ${orderColumns} ${joins} JOIN v2_ticket_batch_lines l ON l.order_id=o.id
      WHERE l.batch_id=$1 AND NOT EXISTS(SELECT FROM v2_ticket_batch_lines x JOIN v2_orders y ON y.id=x.order_id
        WHERE x.batch_id=$1 AND (y.status='MANQUE_STOCK' OR $2::uuid IS NOT NULL AND y.merchant_id<>$2))
      ORDER BY l.position`,[param(request),user.merchantId??null])).rows;
    if (!rows.length) throw missing('Lot de tickets introuvable ou indisponible.');
    return sendFile(reply,'tickets-100x100.pdf',pdfMime,await ticketPdf(rows as Parameters<typeof ticketPdf>[0]));
  });
  app.post('/api/v2/tickets/:id/collect',async request=>{
    const user=await ctx.user(request); check(user,'dispatch.manage');
    z.object({ confirmed:z.literal(true) }).strict().parse(request.body);
    const rows=(await pool.query<{tracking_code:string}>(`SELECT o.tracking_code FROM v2_ticket_batch_lines l
      JOIN v2_orders o ON o.id=l.order_id WHERE l.batch_id=$1 ORDER BY l.position`,[param(request)])).rows;
    if (!rows.length) throw missing();
    const results=[];
    for (const row of rows) {
      try {
        results.push(await transaction(pool,db=>collect(db,user,{ trackingCode:row.tracking_code,method:'MANUAL',confirmed:true,requestKey:randomUUID() },true)));
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        results.push({ code:row.tracking_code,outcome:error.code,message:error.message });
      }
    }
    return { results };
  });
}
