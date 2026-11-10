import { z } from 'zod';
import { lock, one, transaction, type Transaction } from './db.js';
import { filterWindow, mainWarehouse, scanInput, type Order } from './domain.js';
import { bonPdf, pdfMime } from './documents.js';
import { ApiError, conflict, forbidden, missing, page, param, sendFile, text, uuid } from './http.js';
import { clearNotice, notifyMerchant } from './notifications.js';
import { confirmScan, existingScan, physicalEvent } from './orders.js';
import type { Principal } from './security/authorization.js';
import { audit, check, ownScope, type Context } from './security/session.js';

interface Bon { id:string; merchant_id:string; merchant:string; phone:string|null; status:string; revision:number; created_at:Date }
const base='/api/v2/merchant-returns';
const selection=z.object({ ids:z.array(uuid).min(1).max(5000).optional(),all:z.literal(true).optional(),...filterWindow }).strict()
  .refine(input=>Boolean(input.ids)!==Boolean(input.all));

async function getBon(db:Transaction,user:Principal,id:string,locked=false) {
  const bon=await one<Bon>(db,`SELECT b.*,m.name AS merchant,m.phone FROM v2_merchant_return_bons b JOIN v2_merchants m ON m.id=b.merchant_id
    WHERE b.id=$1 AND ($2::uuid IS NULL OR b.merchant_id=$2)${locked?' FOR UPDATE OF b':''}`,[id,user.merchantId??null]);
  if (!bon) throw missing('Bon de retour marchand introuvable.');
  return bon;
}

async function lines(db:Transaction,bonId:string) {
  return (await db.query<Parameters<typeof bonPdf>[0]['rows'][number]>(`SELECT o.id,o.tracking_code,q.is_exchange,q.damaged,q.received_at,
      a.damage_note,a.damage_photo_id,l.verified_at
    FROM v2_merchant_return_lines l JOIN v2_merchant_return_queue q ON q.order_id=l.order_id
    JOIN v2_orders o ON o.id=l.order_id JOIN v2_return_bon_lines a ON a.id=q.agency_line_id WHERE l.bon_id=$1 ORDER BY o.tracking_code`,[bonId])).rows;
}

async function revise(db:Transaction,user:Principal,bon:Bon,action:string,metadata:Record<string,unknown>={}) {
  await db.query('UPDATE v2_merchant_return_bons SET revision=revision+1 WHERE id=$1',[bon.id]);
  await audit(db,user,'MERCHANT_RETURN_'+action,'MERCHANT_RETURN_BON',bon.id,{ revision:bon.revision+1,...metadata });
}

export function merchantReturnRoutes(ctx:Context) {
  const { app,pool }=ctx;
  app.get(base,async request=>{
    const user=await ctx.user(request); check(user,'merchant_returns.read',ownScope(user));
    const query=z.object({ merchantId:uuid.optional(),page }).parse(request.query);
    if (user.merchantId && query.merchantId && user.merchantId!==query.merchantId) throw forbidden();
    const {rows}=await pool.query(`SELECT b.*,m.name AS merchant,COUNT(*) OVER()::int AS total,
      (SELECT COUNT(*)::int FROM v2_merchant_return_lines l WHERE l.bon_id=b.id) AS parcels
      FROM v2_merchant_return_bons b JOIN v2_merchants m ON m.id=b.merchant_id WHERE ($1::uuid IS NULL OR b.merchant_id=$1)
      ORDER BY b.created_at DESC,b.id LIMIT 50 OFFSET $2`,[user.merchantId??query.merchantId??null,(query.page-1)*50]);
    return { rows,total:rows[0]?.total??0,page:query.page };
  });
  app.get(base+'/queue',async request=>{
    const user=await ctx.user(request); check(user,'merchant_returns.manage');
    const query=z.object({...filterWindow,merchantId:uuid.optional(),page}).parse(request.query);
    const pending=`FROM v2_merchant_return_queue q JOIN v2_orders o ON o.id=q.order_id JOIN v2_merchants m ON m.id=q.merchant_id
      WHERE NOT EXISTS(SELECT FROM v2_merchant_return_lines l WHERE l.order_id=q.order_id)
      AND ($1::uuid IS NULL OR q.merchant_id=$1) AND ($2::timestamptz IS NULL OR q.received_at>=$2)
      AND ($3::timestamptz IS NULL OR q.received_at<$3) AND ($4::text IS NULL OR strpos(o.tracking_code,upper($4))>0 OR strpos(o.phone,$4)>0)`;
    const args=[query.merchantId??null,query.from??null,query.to??null,query.search??null];
    const [counts,parcels]=await Promise.all([
      pool.query(`SELECT m.id,m.name,COUNT(*)::int AS pending ${pending} GROUP BY m.id ORDER BY pending DESC,m.name`,args),
      pool.query(`SELECT q.*,o.tracking_code,o.phone,COUNT(*) OVER()::int AS total ${pending}
        ORDER BY q.received_at DESC,q.order_id LIMIT 50 OFFSET $5`,[...args,(query.page-1)*50]),
    ]);
    return { merchants:counts.rows,rows:parcels.rows,total:parcels.rows[0]?.total??0,page:query.page };
  });
  app.post(base,async (request,reply)=>{
    const user=await ctx.user(request); check(user,'merchant_returns.manage');
    const input=z.object({merchantId:uuid}).strict().parse(request.body);
    const bon=await transaction(pool,async db=>{
      const row=await one<{id:string}>(db,'INSERT INTO v2_merchant_return_bons(merchant_id,created_by) VALUES($1,$2) RETURNING id',[input.merchantId,user.id]);
      await audit(db,user,'MERCHANT_RETURN_CREATED','MERCHANT_RETURN_BON',row!.id,{revision:1});
      return getBon(db,user,row!.id);
    });
    return reply.code(201).send(bon);
  });
  app.get(base+'/:id',async request=>{
    const user=await ctx.user(request); check(user,'merchant_returns.read',ownScope(user));
    const bon=await getBon(pool,user,param(request));
    const number=bon.phone?.replace(/\D/g,'').replace(/^0/,'212');
    const message='Bonjour, votre retour TransitFlow '+bon.id+' est en cours. Retrouvez les colis dans votre espace marchand.';
    return { bon:{...bon,phone:undefined},rows:await lines(pool,bon.id),
      whatsapp:!user.merchantId&&number?`https://wa.me/${number}?text=${encodeURIComponent(message)}`:null };
  });
  app.post(base+'/:id/add',async request=>{
    const user=await ctx.user(request); check(user,'merchant_returns.manage');
    const id=param(request),input=selection.parse(request.body);
    return transaction(pool,async db=>{
      const existing=await getBon(db,user,id);
      await lock(db,'merchant-return',existing.merchant_id);
      const bon=await getBon(db,user,id,true);
      if (bon.status!=='EN_PREPARATION') throw conflict('BON_LOCKED','Le bon n’est plus en préparation.');
      const {rowCount}=await db.query(`INSERT INTO v2_merchant_return_lines(bon_id,order_id)
        SELECT $1,q.order_id FROM v2_merchant_return_queue q JOIN v2_orders o ON o.id=q.order_id
        WHERE q.merchant_id=$2 AND ($3::uuid[] IS NULL OR q.order_id=ANY($3))
        AND ($4::timestamptz IS NULL OR q.received_at>=$4) AND ($5::timestamptz IS NULL OR q.received_at<$5)
        AND ($6::text IS NULL OR strpos(o.tracking_code,upper($6))>0 OR strpos(o.phone,$6)>0)
        AND o.current_holder_type='WAREHOUSE' ON CONFLICT(order_id) DO NOTHING`,
        [id,bon.merchant_id,input.ids??null,input.from??null,input.to??null,input.search??null]);
      if (rowCount) await revise(db,user,bon,'ADDED',{count:rowCount});
      return { added:rowCount };
    });
  });
  app.post(base+'/:id/remove',async request=>{
    const user=await ctx.user(request); check(user,'merchant_returns.manage');
    const id=param(request);
    const { ids }=z.object({ ids:z.array(uuid).min(1).max(5000),confirmed:z.literal(true) }).strict().parse(request.body);
    return transaction(pool,async db=>{
      const bon=await getBon(db,user,id,true);
      if (bon.status!=='EN_PREPARATION') throw conflict('BON_LOCKED','Le bon n’est plus en préparation.');
      const result=await db.query('DELETE FROM v2_merchant_return_lines WHERE bon_id=$1 AND order_id=ANY($2::uuid[])',[id,ids]);
      if (result.rowCount) await revise(db,user,bon,'REMOVED',{count:result.rowCount});
      return { removed:result.rowCount };
    });
  });
  app.post(base+'/:id/verify',async request=>{
    const user=await ctx.user(request); check(user,'merchant_returns.manage');
    const input=scanInput.parse(request.body),id=param(request);
    confirmScan(input);
    return transaction(pool,async db=>{
      const bon=await getBon(db,user,id,true);
      if (bon.status!=='EN_PREPARATION') throw conflict('BON_LOCKED','Le bon n’est plus en préparation.');
      const order=await one<Order & {verified_at:Date|null}>(db,`SELECT o.*,l.verified_at FROM v2_merchant_return_lines l JOIN v2_orders o ON o.id=l.order_id
        WHERE l.bon_id=$1 AND o.tracking_code=$2 FOR UPDATE OF o`,[id,input.trackingCode]);
      if (!order) throw new ApiError(404,'SCAN_UNKNOWN','Ce code ne figure pas dans ce bon.');
      if (await existingScan(db,order,user,input,'WAREHOUSE',null)) return { outcome:'REPLAY',code:input.trackingCode };
      if (order.verified_at) throw conflict('SCAN_DUPLICATE','Ce colis a déjà été contrôlé.');
      if (order.current_holder_type!=='WAREHOUSE') throw conflict('SCAN_WRONG_STATUS','Ce colis n’est plus à l’entrepôt.');
      await physicalEvent(db,order,user,input,'WAREHOUSE',await mainWarehouse(db));
      await db.query('UPDATE v2_merchant_return_lines SET verified_at=clock_timestamp(),verified_by=$3 WHERE bon_id=$1 AND order_id=$2',[id,order.id,user.id]);
      await audit(db,user,'MERCHANT_RETURN_VERIFIED','MERCHANT_RETURN_BON',id,{orderId:order.id,method:input.method});
      return { outcome:'RECEIVED',code:input.trackingCode };
    });
  });
  app.post(base+'/:id/state',async request=>{
    const user=await ctx.user(request),id=param(request);
    const input=z.object({action:z.enum(['SEND','REOPEN','RECEIVE','CONFIRM','EXCEPTIONAL_REOPEN']),confirmed:z.literal(true).optional(),
      reason:text(400).optional()}).strict().parse(request.body);
    check(user,input.action==='CONFIRM'?'merchant_returns.confirm':'merchant_returns.manage',ownScope(user));
    return transaction(pool,async db=>{
      const bon=await getBon(db,user,id,true);
      if (input.action==='CONFIRM' && (!user.merchantId || !input.confirmed)) throw forbidden();
      const group='merchant-return:'+id;
      let status;
      if (input.action==='SEND' && bon.status==='EN_PREPARATION') {
        if (!await one(db,'SELECT 1 FROM v2_merchant_return_lines WHERE bon_id=$1',[id])) throw conflict('BON_EMPTY','Ajoutez des colis.');
        status='EXPEDIE_VERS_CLIENT';
      } else if (input.action==='REOPEN' && bon.status==='EXPEDIE_VERS_CLIENT') {
        status='EN_PREPARATION';
      } else if (input.action==='RECEIVE' && bon.status==='EXPEDIE_VERS_CLIENT' && input.confirmed) {
        await db.query("UPDATE v2_merchant_return_bons SET status='RECU_PAR_CLIENT',received_at=clock_timestamp() WHERE id=$1",[id]);
        await db.query(`UPDATE v2_orders o SET current_holder_type='MERCHANT',current_holder_id=$2,holder_updated_at=clock_timestamp()
          FROM v2_merchant_return_lines l WHERE l.bon_id=$1 AND l.order_id=o.id`,[id,bon.merchant_id]);
        await audit(db,user,'MERCHANT_RETURN_RECEIVED_BY_CLIENT','MERCHANT_RETURN_BON',id);
        status='EN_ATTENTE_CONFIRMATION';
        await notifyMerchant(db,bon.merchant_id,group,'Un bon de retour attend votre confirmation.',id);
      } else if (input.action==='CONFIRM' && bon.status==='EN_ATTENTE_CONFIRMATION') {
        status='CONFIRME_PAR_MARCHAND';
        await db.query('UPDATE v2_merchant_return_bons SET confirmed_at=clock_timestamp() WHERE id=$1',[id]);
        await clearNotice(db,group);
      } else if (input.action==='EXCEPTIONAL_REOPEN' && user.role==='ADMIN' && input.reason && bon.status==='EN_ATTENTE_CONFIRMATION') {
        status='EXPEDIE_VERS_CLIENT';
        await db.query('UPDATE v2_merchant_return_bons SET received_at=NULL WHERE id=$1',[id]);
        await clearNotice(db,group);
      } else throw conflict('BON_STATUS','Action indisponible dans cet état.');
      await db.query('UPDATE v2_merchant_return_bons SET status=$2 WHERE id=$1',[id,status]);
      await revise(db,user,bon,input.action,{ status,reason:input.reason });
      return { status,revision:bon.revision+1 };
    });
  });
  app.get(base+'/:id/pdf',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'merchant_returns.read',ownScope(user));
    const bon=await getBon(pool,user,param(request));
    const pdf=await bonPdf({ title:'Bon de retour marchand',id:bon.id,name:bon.merchant,date:bon.created_at,
      rows:await lines(pool,bon.id),merchant:true,revision:bon.revision });
    return sendFile(reply,'retour-marchand-'+bon.id+'.pdf',pdfMime,pdf);
  });
}
