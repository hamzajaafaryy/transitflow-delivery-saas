import { z } from 'zod';
import { lock, one, transaction, type Transaction } from './db.js';
import { activeAgency, filterWindow, type Order, type Status } from './domain.js';
import { centimes, conflict, forbidden, key, missing, page, param, text, uuid } from './http.js';
import { audit, check, ownScope, type Context } from './security/session.js';

export async function reconcileMoney(db: Transaction, order: Order, status: Status, eventKey: string) {
  await lock(db,'merchant-finance',order.merchant_id);
  const ledger = await one<{ amount:string }>(db,`SELECT COALESCE(SUM(amount_centimes),0)::bigint AS amount
    FROM v2_cod_ledger WHERE order_id=$1 AND kind IN ('COMMANDE','AJUSTEMENT')`,[order.id]);
  const snapshot=await one<{ invoice_id:string; paid_at:Date|null }>(db,`SELECT i.id AS invoice_id,i.paid_at
    FROM v2_merchant_invoice_lines l JOIN v2_merchant_invoices i ON i.id=l.invoice_id WHERE l.order_id=$1 FOR UPDATE OF i`,[order.id]);
  const owed = status==='LIVRE'
    ? Number(order.cod_centimes)-Number(order.delivery_fee_centimes)-Number(order.packaging_centimes)
    : status==='REFUSE' ? -Number(order.refused_fee_centimes) : 0;
  const delta=owed-Number(ledger?.amount ?? 0);
  if (delta) {
    const offsetPaid=await one(db,`SELECT 1 FROM v2_invoice_offsets f JOIN v2_merchant_invoices i ON i.id=f.invoice_id
      JOIN v2_cod_ledger l ON l.id=f.ledger_id WHERE l.order_id=$1 AND i.paid_at IS NOT NULL LIMIT 1`,[order.id]);
    await db.query(`INSERT INTO v2_cod_ledger(merchant_id,order_id,event_key,kind,amount_centimes)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_key) DO NOTHING`,
      [order.merchant_id,order.id,eventKey,snapshot?.paid_at||offsetPaid?'AJUSTEMENT':'COMMANDE',delta]);
    if (snapshot && !snapshot.paid_at) {
      await db.query('UPDATE v2_merchant_invoice_lines SET amount_centimes=amount_centimes+$2 WHERE order_id=$1',[order.id,delta]);
      await updateInvoiceTotal(db,snapshot.invoice_id);
    }
  }

  if (!order.agency_id) return;
  await lock(db,'agency-finance',order.agency_id);
  const bon=await one<{ id:string; paid_at:Date|null }>(db,`SELECT b.id,b.paid_at FROM v2_agency_payment_lines l
    JOIN v2_agency_payment_bons b ON b.id=l.bon_id WHERE l.order_id=$1 FOR UPDATE OF b`,[order.id]);
  if (bon && !bon.paid_at) {
    await db.query('UPDATE v2_agency_payment_lines SET eligible=$2 WHERE order_id=$1',[order.id,status==='LIVRE']);
    await db.query(`UPDATE v2_agency_payment_bons SET expected_centimes=(
      SELECT COALESCE(SUM(cod_centimes),0) FROM v2_agency_payment_lines WHERE bon_id=$1 AND eligible) WHERE id=$1`,[bon.id]);
  }
}

async function updateInvoiceTotal(db: Transaction, id: string) {
  await db.query(`UPDATE v2_merchant_invoices SET total_centimes=(
    (SELECT COALESCE(SUM(amount_centimes),0) FROM v2_merchant_invoice_lines WHERE invoice_id=$1) +
    (SELECT COALESCE(SUM(l.amount_centimes),0) FROM v2_invoice_offsets f JOIN v2_cod_ledger l ON l.id=f.ledger_id WHERE f.invoice_id=$1))
    WHERE id=$1`,[id]);
}

const batch = z.object({ ids:z.array(uuid).max(5000).optional(), all:z.literal(true).optional(),
  from:filterWindow.from,to:filterWindow.to }).strict()
  .refine(input => Boolean(input.ids?.length) !== Boolean(input.all),'Sélection requise');
const paymentColumns = `b.*,a.name AS agency,GREATEST(b.expected_centimes-b.received_centimes,0)::bigint AS outstanding_centimes,
  GREATEST(b.received_centimes-b.expected_centimes,0)::bigint AS excess_centimes`;

export function financeRoutes(ctx: Context) {
  const { app,pool }=ctx;
  app.get('/api/v2/finance/agencies',async request => {
    const user=await ctx.user(request); check(user,'agency_payments.read');
    const query=z.object({ page,agencyId:uuid.optional() }).parse(request.query);
    const {rows}=await pool.query(`SELECT ${paymentColumns},COUNT(*) OVER()::int AS total FROM v2_agency_payment_bons b JOIN v2_agencies a ON a.id=b.agency_id
      WHERE ($1::uuid IS NULL OR b.agency_id=$1) ORDER BY b.created_at DESC,b.id LIMIT 50 OFFSET $2`,[query.agencyId??null,(query.page-1)*50]);
    return { rows,total:rows[0]?.total??0,page:query.page };
  });
  app.get('/api/v2/finance/agencies/:id/eligible',async request => {
    const user=await ctx.user(request); check(user,'agency_payments.create');
    const query=z.object({ from:filterWindow.from,to:filterWindow.to,page }).parse(request.query);
    const {rows}=await pool.query(`SELECT o.id,o.tracking_code,o.cod_centimes,o.delivered_at,COUNT(*) OVER()::int AS total
      FROM v2_orders o WHERE o.agency_id=$1 AND o.status='LIVRE' AND o.delivered_at IS NOT NULL
      AND ($2::timestamptz IS NULL OR o.delivered_at>=$2) AND ($3::timestamptz IS NULL OR o.delivered_at<$3)
      AND NOT EXISTS(SELECT FROM v2_agency_payment_lines l WHERE l.order_id=o.id)
      ORDER BY o.delivered_at DESC,o.id LIMIT 50 OFFSET $4`,[param(request),query.from??null,query.to??null,(query.page-1)*50]);
    return { rows,total:rows[0]?.total??0 };
  });
  app.post('/api/v2/finance/agencies/:id/bons',async (request,reply) => {
    const user=await ctx.user(request); check(user,'agency_payments.create');
    const agencyId=param(request);
    const input=batch.parse(request.body);
    const bon=await transaction(pool,async db=>{
      await activeAgency(db,agencyId);
      await lock(db,'agency-finance',agencyId);
      const selection=(await db.query<{ id:string;cod_centimes:string }>(`SELECT o.id,o.cod_centimes FROM v2_orders o
        WHERE o.agency_id=$1 AND o.status='LIVRE' AND o.delivered_at IS NOT NULL
        AND ($2::uuid[] IS NULL OR o.id=ANY($2)) AND ($3::timestamptz IS NULL OR o.delivered_at>=$3)
        AND ($4::timestamptz IS NULL OR o.delivered_at<$4)
        AND NOT EXISTS(SELECT FROM v2_agency_payment_lines l WHERE l.order_id=o.id) ORDER BY o.id`,
        [agencyId,input.ids??null,input.from??null,input.to??null])).rows;
      if (!selection.length || input.ids && selection.length!==new Set(input.ids).size) {
        throw conflict('NO_ELIGIBLE_PARCELS','La sélection contient des colis non éligibles ou déjà affectés.');
      }
      const created=await one<{id:string}>(db,`INSERT INTO v2_agency_payment_bons(agency_id,created_by,expected_centimes)
        VALUES($1,$2,$3) RETURNING *`,[agencyId,user.id,selection.reduce((sum,o)=>sum+BigInt(o.cod_centimes),0n).toString()]);
      await db.query(`INSERT INTO v2_agency_payment_lines(bon_id,order_id,cod_centimes)
        SELECT $1,id,cod_centimes FROM v2_orders WHERE id=ANY($2::uuid[])`,[created!.id,selection.map(o=>o.id)]);
      await audit(db,user,'AGENCY_PAYMENT_CREATED','AGENCY_PAYMENT_BON',created!.id,{count:selection.length});
      return created;
    });
    return reply.code(201).send(bon);
  });
  app.get('/api/v2/finance/agency-bons/:id',async request => {
    const user=await ctx.user(request); check(user,'agency_payments.read');
    const id=param(request);
    const bon=await one(pool,`SELECT ${paymentColumns} FROM v2_agency_payment_bons b JOIN v2_agencies a ON a.id=b.agency_id WHERE b.id=$1`,[id]);
    if (!bon) throw missing();
    const lines=(await pool.query(`SELECT o.tracking_code,l.cod_centimes,l.eligible FROM v2_agency_payment_lines l
      JOIN v2_orders o ON o.id=l.order_id WHERE l.bon_id=$1 ORDER BY o.tracking_code`,[id])).rows;
    const receipts=(await pool.query('SELECT id,amount_centimes,reference,entered_by,received_at FROM v2_agency_payment_receipts WHERE bon_id=$1 ORDER BY received_at',[id])).rows;
    return { bon,lines,receipts };
  });
  app.post('/api/v2/finance/agency-bons/:id/remittance',async request => {
    const user=await ctx.user(request); check(user,'agency_payments.create');
    const id=param(request);
    const input=z.object({ amount:centimes.refine(n=>n>0),reference:text(140).optional(),requestKey:key }).strict().parse(request.body);
    return transaction(pool,async db=>{
      const bon=await one<{status:string;expected_centimes:string;received_centimes:string}>(db,'SELECT * FROM v2_agency_payment_bons WHERE id=$1 FOR UPDATE',[id]);
      if (!bon) throw missing();
      const prior=await one<{ bon_id:string; amount_centimes:string; entered_by:string;reference:string|null }>(db,
        'SELECT * FROM v2_agency_payment_receipts WHERE request_key=$1',[input.requestKey]);
      if (prior) {
        if (prior.bon_id===id && Number(prior.amount_centimes)===input.amount && prior.entered_by===user.id && prior.reference===(input.reference??null)) return { replay:true };
        throw conflict('KEY_REUSED','Clé de versement déjà utilisée.');
      }
      if (bon.status==='PAYE') throw conflict('PAID','Ce bon est déjà payé.');
      if (BigInt(bon.received_centimes)+BigInt(input.amount)>BigInt(bon.expected_centimes)) {
        throw conflict('EXCESS_REMITTANCE','Le montant dépasse le reste à recevoir.');
      }
      await db.query('INSERT INTO v2_agency_payment_receipts(bon_id,amount_centimes,reference,entered_by,request_key) VALUES($1,$2,$3,$4,$5)',
        [id,input.amount,input.reference??null,user.id,input.requestKey]);
      await db.query('UPDATE v2_agency_payment_bons SET received_centimes=received_centimes+$2 WHERE id=$1',[id,input.amount]);
      await audit(db,user,'AGENCY_REMITTANCE','AGENCY_PAYMENT_BON',id,{ amountCentimes:input.amount });
      return { replay:false };
    });
  });
  app.post('/api/v2/finance/agency-bons/:id/confirm-paid',async request=>{
    const user=await ctx.user(request); check(user,'agency_payments.confirm_paid');
    z.object({ confirmed:z.literal(true) }).strict().parse(request.body);
    const id=param(request);
    await transaction(pool,async db=>{
      if (!await one(db,'SELECT id FROM v2_agency_payment_bons WHERE id=$1 FOR UPDATE',[id])) throw missing();
      await db.query('SELECT v2_confirm_agency_payment($1,$2)',[id,user.id]);
    });
    return { status:'PAYE' };
  });

  app.get('/api/v2/finance/merchant',async request=>{
    const user=await ctx.user(request); check(user,'merchant_finance.read',ownScope(user));
    const query=z.object({ merchantId:uuid.optional(),page }).parse(request.query);
    if (user.merchantId && query.merchantId && query.merchantId!==user.merchantId) throw forbidden();
    const merchantId=user.merchantId??query.merchantId;
    if (!merchantId) return { rows:[] };
    const [invoices,balance]=await Promise.all([
      pool.query(`SELECT i.id,i.merchant_id,i.total_centimes,i.paid_at,i.method,i.created_at,COUNT(*) OVER()::int AS total,
        (SELECT COUNT(*)::int FROM v2_merchant_invoice_lines l WHERE l.invoice_id=i.id) AS parcels
        FROM v2_merchant_invoices i WHERE i.merchant_id=$1 ORDER BY i.created_at DESC,i.id LIMIT 50 OFFSET $2`,[merchantId,(query.page-1)*50]),
      one(pool,`SELECT COALESCE((SELECT SUM(amount_centimes) FROM v2_cod_ledger WHERE merchant_id=$1),0)::bigint AS balance_centimes,
        COALESCE((SELECT SUM(total_centimes) FROM v2_merchant_invoices WHERE merchant_id=$1 AND paid_at IS NULL AND total_centimes>0),0)::bigint AS reserved_centimes`,[merchantId]),
    ]);
    return { rows:invoices.rows,total:invoices.rows[0]?.total??0,page:query.page,...balance };
  });
  app.post('/api/v2/finance/merchant/:id/invoices',async (request,reply)=>{
    const user=await ctx.user(request);
    if (user.role!=='ADMIN') throw forbidden();
    const id=param(request),input=batch.parse(request.body);
    const invoice=await transaction(pool,async db=>{
      await lock(db,'merchant-finance',id);
      const selected=(await db.query<{ id:string;amount:string }>(`SELECT o.id,COALESCE(SUM(l.amount_centimes),0)::bigint AS amount
        FROM v2_orders o LEFT JOIN v2_cod_ledger l ON l.order_id=o.id AND l.kind='COMMANDE'
        WHERE o.merchant_id=$1 AND o.status='LIVRE' AND o.delivered_at IS NOT NULL
          AND ($2::uuid[] IS NULL OR o.id=ANY($2)) AND ($3::timestamptz IS NULL OR o.delivered_at>=$3)
          AND ($4::timestamptz IS NULL OR o.delivered_at<$4)
          AND NOT EXISTS(SELECT FROM v2_merchant_invoice_lines li WHERE li.order_id=o.id)
        GROUP BY o.id ORDER BY o.id`,[id,input.ids??null,input.from??null,input.to??null])).rows;
      if (!selected.length || input.ids && selected.length!==new Set(input.ids).size) {
        throw conflict('NO_ELIGIBLE_PARCELS','Aucun colis livré éligible dans cette sélection.');
      }
      const row=await one<{id:string}>(db,'INSERT INTO v2_merchant_invoices(merchant_id,created_by,total_centimes) VALUES($1,$2,0) RETURNING id',[id,user.id]);
      await db.query(`INSERT INTO v2_merchant_invoice_lines(invoice_id,order_id,amount_centimes)
        SELECT $1,* FROM unnest($2::uuid[],$3::bigint[])`,[row!.id,selected.map(x=>x.id),selected.map(x=>x.amount)]);
      await db.query(`INSERT INTO v2_invoice_offsets(ledger_id,invoice_id)
        SELECT l.id,$2 FROM v2_cod_ledger l LEFT JOIN v2_orders o ON o.id=l.order_id
        WHERE l.merchant_id=$1 AND (l.kind='AJUSTEMENT' OR l.kind='COMMANDE' AND o.status<>'LIVRE'
          AND NOT EXISTS(SELECT FROM v2_merchant_invoice_lines li WHERE li.order_id=o.id))
        AND NOT EXISTS(SELECT FROM v2_invoice_offsets f WHERE f.ledger_id=l.id)`,[id,row!.id]);
      await updateInvoiceTotal(db,row!.id);
      const result=await one<{total_centimes:string}>(db,'SELECT * FROM v2_merchant_invoices WHERE id=$1',[row!.id]);
      if (Number(result!.total_centimes)<0) throw conflict('MERCHANT_DEBT','Le COD de la sélection ne couvre pas la dette marchand.');
      await audit(db,user,'MERCHANT_INVOICE_CREATED','MERCHANT_INVOICE',row!.id,{ count:selected.length });
      return result;
    });
    return reply.code(201).send(invoice);
  });
  app.post('/api/v2/finance/invoices/:id/pay',async request=>{
    const user=await ctx.user(request);
    if (user.role!=='ADMIN') throw forbidden();
    const id=param(request);
    const input=z.object({ method:z.enum(['ESPECES','VIREMENT']),reference:text(140).optional(),confirmed:z.literal(true) }).strict()
      .refine(row=>row.method!=='VIREMENT'||row.reference).parse(request.body);
    return transaction(pool,async db=>{
      const existing=await one<{merchant_id:string}>(db,'SELECT merchant_id FROM v2_merchant_invoices WHERE id=$1',[id]);
      if (!existing) throw missing();
      await lock(db,'merchant-finance',existing.merchant_id);
      const invoice=await one<{paid_at:Date|null;total_centimes:string}>(db,'SELECT * FROM v2_merchant_invoices WHERE id=$1 FOR UPDATE',[id]);
      if (invoice!.paid_at) throw conflict('PAID','Ce relevé est déjà payé.');
      if (Number(invoice!.total_centimes)<0) throw conflict('MERCHANT_DEBT','Le relevé présente un solde débiteur.');
      await db.query('UPDATE v2_merchant_invoices SET paid_at=now(),paid_by=$2,method=$3,reference=$4 WHERE id=$1',[id,user.id,input.method,input.reference??null]);
      await db.query(`INSERT INTO v2_cod_ledger(merchant_id,invoice_id,event_key,kind,amount_centimes)
        VALUES($1,$2,$3,'VERSEMENT',$4)`,[existing.merchant_id,id,'payment:'+id,(-BigInt(invoice!.total_centimes)).toString()]);
      await audit(db,user,'MERCHANT_INVOICE_PAID','MERCHANT_INVOICE',id,{ method:input.method,amountCentimes:invoice!.total_centimes });
      return { status:'PAYE' };
    });
  });
}
