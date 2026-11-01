import { randomUUID } from 'node:crypto';

const clean=(value,max=160)=>String(value??'').trim().slice(0,max);
const bad=(status,message)=>Object.assign(new Error(message),{status});
const dateRegex=/^\d{4}-\d{2}-\d{2}$/;
const asMoney=x=>Number(x)||0;
const formatter=new Intl.DateTimeFormat('en-US',{timeZone:'Africa/Casablanca',year:'numeric',month:'2-digit',day:'2-digit'});
function moroccoDate(instant){const parts=Object.fromEntries(formatter.formatToParts(instant).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}`;}
function businessWindow(params){
 const period=clean(params.get('period')||'yesterday',20);
 if(period==='24h')return {period,label:'Dernières 24 heures',start:new Date(Date.now()-86400000).toISOString(),end:new Date().toISOString(),date:null};
 let day;
 if(period==='today')day=moroccoDate(new Date());
 else if(period==='yesterday')day=moroccoDate(new Date(Date.now()-86400000));
 else if(period==='date')day=clean(params.get('date'),10);
 else throw bad(400,'Période invalide');
 if(!dateRegex.test(day)||!Number.isFinite(Date.parse(day+'T12:00:00Z'))||moroccoDate(new Date(day+'T12:00:00Z'))!==day)throw bad(400,'Date invalide');
 const start=localDayStart(day),next=new Date(Date.parse(day+'T12:00:00Z')+86400000);
 const end=localDayStart(moroccoDate(next));
 return {period,label:day,start:start.toISOString(),end:end.toISOString(),date:day};
}
function localDayStart(day){
 const [year,month,date]=day.split('-').map(Number);let utc=Date.UTC(year,month-1,date);
 const partsFmt=new Intl.DateTimeFormat('en-US',{timeZone:'Africa/Casablanca',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
 for(let n=0;n<3;n++){
  const o=Object.fromEntries(partsFmt.formatToParts(new Date(utc)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  const expressed=Date.UTC(o.year,o.month-1,o.day,o.hour,o.minute);
  const corrected=utc-(expressed-Date.UTC(year,month-1,date));
  if(corrected===utc)break;
  utc=corrected;
 }
 return new Date(utc);
}
const merchantRole=user=>user.role==='MERCHANT';
function requireFinance(user){if(!['ADMIN','FINANCE'].includes(user.role))throw bad(403,'Rôle comptable requis');}
function scopedMerchant(ctx,requested){
 const {stmt,companyId,user}=ctx;
 if(merchantRole(user)){
  if(!user.merchant_id||requested&&requested!==user.merchant_id)throw bad(403,'Marchand non autorisé');
  return user.merchant_id;
 }
 requireFinance(user);
 const merchantId=clean(requested,40);
 if(!merchantId)throw bad(400,'merchantId requis');
 if(!stmt('SELECT 1 FROM merchants WHERE id=? AND company_id=?',merchantId,companyId))throw bad(404,'Marchand introuvable');
 return merchantId;
}
function findRate(ctx,merchantId,city){
 const key=clean(city,90).toLowerCase();
 return ctx.stmt(`SELECT fee_centimes,city_key FROM merchant_rate_cards
  WHERE company_id=? AND merchant_id=? AND city_key IN (?, '*') ORDER BY CASE WHEN city_key=? THEN 0 ELSE 1 END LIMIT 1`,ctx.companyId,merchantId,key,key);
}
function stockRows(ctx,merchantId){
 const products=ctx.all(`SELECT p.id,p.sku,p.name,p.barcode,p.low_stock_threshold,
 (SELECT COALESCE(SUM(q.quantity_remaining),0) FROM stock_quarantine q WHERE q.company_id=p.company_id AND q.product_id=p.id AND q.merchant_id=p.merchant_id) AS quarantined,
 COALESCE(SUM(l.quantity_on_hand),0) AS onHand,
 COALESCE(SUM(l.quantity_reserved),0) AS reserved
 FROM inventory_products p LEFT JOIN stock_lots l ON l.product_id=p.id AND l.company_id=p.company_id
 WHERE p.company_id=? AND p.merchant_id=? GROUP BY p.id ORDER BY p.name,p.sku`,ctx.companyId,merchantId)
 .map(p=>({...p,available:p.onHand-p.reserved}));
 const warehouses=ctx.all(`SELECT p.id AS productId,p.sku,p.name,l.location AS warehouse,
 SUM(l.quantity_on_hand) AS onHand,SUM(l.quantity_reserved) AS reserved,COUNT(*) AS lots
 FROM inventory_products p JOIN stock_lots l ON l.product_id=p.id AND l.company_id=p.company_id
 WHERE p.company_id=? AND p.merchant_id=? GROUP BY p.id,l.location ORDER BY p.name,l.location`,ctx.companyId,merchantId)
 .map(w=>({...w,available:w.onHand-w.reserved}));
 const lots=ctx.all(`SELECT p.sku,p.name,l.id,l.location AS warehouse,l.received_at AS receivedAt,
 l.quantity_on_hand AS onHand,l.quantity_reserved AS reserved, l.quantity_on_hand-l.quantity_reserved AS available
 FROM inventory_products p JOIN stock_lots l ON l.product_id=p.id AND l.company_id=p.company_id
 WHERE p.company_id=? AND p.merchant_id=? ORDER BY l.received_at DESC LIMIT 300`,ctx.companyId,merchantId);
 const allocations=ctx.all(`SELECT s.tracking,s.status,p.sku,p.name,a.quantity,a.state,a.created_at AS createdAt,l.location AS warehouse
 FROM stock_allocations a JOIN inventory_products p ON p.id=a.product_id AND p.company_id=a.company_id
 JOIN shipments s ON s.id=a.shipment_id AND s.company_id=a.company_id
 JOIN stock_lots l ON l.id=a.lot_id AND l.company_id=a.company_id
 WHERE a.company_id=? AND p.merchant_id=? AND s.merchant_id=? ORDER BY a.created_at DESC LIMIT 120`,ctx.companyId,merchantId,merchantId);
 return {products,warehouses,lots,allocations,summary:{skuCount:products.length,unitsPhysical:products.reduce((a,p)=>a+p.onHand,0),unitsReserved:products.reduce((a,p)=>a+p.reserved,0),unitsAvailable:products.reduce((a,p)=>a+p.available,0),unitsQuarantined:products.reduce((a,p)=>a+p.quarantined,0)}};
}
function deliveredRows(ctx,merchantId,window){
 const rows=ctx.all(`SELECT s.id,s.tracking,s.recipient,s.city,s.status,s.cod_centimes AS codCentimes,
 s.delivered_at AS deliveredAt,s.created_at AS createdAt,s.description,
 p.name AS agencyName,
 EXISTS(SELECT 1 FROM ledger l WHERE l.company_id=s.company_id AND l.shipment_id=s.id AND l.type='COD_COLLECTED') AS collected,
 sl.statement_id AS statementId,ms.status AS statementStatus
 FROM shipments s LEFT JOIN agencies p ON p.id=s.agency_id AND p.company_id=s.company_id
 LEFT JOIN merchant_statement_lines sl ON sl.company_id=s.company_id AND sl.shipment_id=s.id
 LEFT JOIN merchant_statements ms ON ms.company_id=s.company_id AND ms.id=sl.statement_id
 WHERE s.company_id=? AND s.merchant_id=? AND s.status='DELIVERED' AND s.delivered_at>=? AND s.delivered_at<?
 ORDER BY s.delivered_at DESC`,ctx.companyId,merchantId,window.start,window.end);
 return rows.map(s=>{
  const rate=findRate(ctx,merchantId,s.city);
  return {...s,collected:s.codCentimes===0||Boolean(s.collected),feeCentimes:rate?.fee_centimes??null,
   estimatedNetCentimes:rate?s.codCentimes-rate.fee_centimes:null,
   feeSource:rate?.city_key??null};
 });
}
function statementList(ctx,merchantId){
 return ctx.all(`SELECT id,reference,service_date AS serviceDate,status,shipment_count AS shipmentCount,
 gross_centimes AS grossCentimes,fee_centimes AS feeCentimes,net_centimes AS netCentimes,adjustment_centimes AS adjustmentCentimes,carried_to_statement_id AS carriedToStatementId,
 created_at AS createdAt,confirmed_at AS confirmedAt,paid_at AS paidAt,payment_reference AS paymentReference
 FROM merchant_statements WHERE company_id=? AND merchant_id=? ORDER BY service_date DESC,created_at DESC LIMIT 120`,ctx.companyId,merchantId);
}
function overview(ctx,merchantId,params){
 const window=businessWindow(params),merchant=ctx.stmt('SELECT id,name,phone FROM merchants WHERE id=? AND company_id=?',merchantId,ctx.companyId);
 if(!merchant)throw bad(404,'Marchand introuvable');
 const deliveries=deliveredRows(ctx,merchantId,window);
 const statements=statementList(ctx,merchantId);
 const balances=ctx.stmt("SELECT COALESCE(SUM(CASE WHEN status<>'PAID' AND carried_to_statement_id IS NULL AND net_centimes>0 THEN net_centimes ELSE 0 END),0) AS awaiting,COALESCE(SUM(CASE WHEN status<>'PAID' AND carried_to_statement_id IS NULL AND net_centimes<0 THEN -net_centimes ELSE 0 END),0) AS debt,COALESCE(SUM(CASE WHEN status='PAID' AND net_centimes>0 THEN net_centimes ELSE 0 END),0) AS paid FROM merchant_statements WHERE company_id=? AND merchant_id=?",ctx.companyId,merchantId);
 const summary={delivered:deliveries.length,grossDeliveredCentimes:deliveries.reduce((a,x)=>a+x.codCentimes,0),
  collected:deliveries.filter(x=>x.collected&&x.codCentimes>0).length,
  collectedCentimes:deliveries.filter(x=>x.collected).reduce((a,x)=>a+x.codCentimes,0),
  pendingCollectionCentimes:deliveries.filter(x=>!x.collected).reduce((a,x)=>a+x.codCentimes,0),
  unpriced:deliveries.filter(x=>x.feeCentimes===null).length,
  collectedReadyForStatementCentimes:deliveries.filter(x=>x.collected&&x.feeCentimes!==null&&!x.statementId).reduce((a,x)=>a+x.estimatedNetCentimes,0),
  statementsAwaitingPaymentCentimes:balances.awaiting,
  debitBalanceCentimes:balances.debt,
  pendingAdjustmentsCentimes:ctx.stmt('SELECT COALESCE(SUM(amount_centimes),0) AS n FROM merchant_adjustments WHERE merchant_id=? AND company_id=? AND applied_statement_id IS NULL',merchantId,ctx.companyId).n,
  statementsPaidCentimes:balances.paid
 };
 return {merchant,window,summary,deliveries,statements,stock:stockRows(ctx,merchantId).summary,
  warning:'Livré ne signifie pas encaissé. Les sommes « à verser » sont un suivi interne, pas un virement bancaire. Tarifs non configurés = net indisponible.'};
}
function esc(s){return String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));}
function printDeliveryReport(ctx,merchantId,params){
 const window=businessWindow(params),merchant=ctx.stmt('SELECT name FROM merchants WHERE id=? AND company_id=?',merchantId,ctx.companyId),company=ctx.stmt('SELECT name FROM company WHERE id=?',ctx.companyId);
 if(!merchant)throw bad(404,'Marchand introuvable');
 const deliveries=deliveredRows(ctx,merchantId,window),cash=n=>(n/100).toLocaleString('fr-MA',{minimumFractionDigits:2,maximumFractionDigits:2})+' MAD';
 const gross=deliveries.reduce((s,d)=>s+d.codCentimes,0),collected=deliveries.filter(x=>x.collected).reduce((s,d)=>s+d.codCentimes,0),unknown=deliveries.filter(x=>x.feeCentimes===null).length;
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rapport de livraisons ${esc(window.label)}</title><style>body{font:13px Arial,sans-serif;color:#1c2a40;padding:25px}header{display:flex;justify-content:space-between;border-bottom:3px solid #4e70df;padding-bottom:17px}h1{margin:0 0 7px}table{width:100%;border-collapse:collapse;margin:24px 0}td,th{border-bottom:1px solid #e2e8f0;padding:11px;text-align:left}th{background:#f3f6fb}p{line-height:1.7}.muted{color:#64748b}.right{text-align:right}strong{color:#111827}.totals{margin-left:auto;max-width:370px}.totals p{display:flex;justify-content:space-between}.print{padding:9px 14px;margin-bottom:14px}.warning{background:#fff5df;padding:11px;border-radius:8px}@media print{.print{display:none}body{padding:0}}</style></head><body><button class="print" onclick="window.print()">Imprimer / Enregistrer en PDF</button><header><div><h1>TransitFlow</h1><strong>${esc(company?.name)}</strong><p class="muted">Rapport des livraisons confirmées</p></div><div class="right"><strong>${esc(merchant.name)}</strong><p>${esc(window.label)}</p><p>${esc(window.period)}</p></div></header><p>Ce rapport liste les colis marqués « Livré » pendant la période indiquée. Il n'atteste ni d'un virement au marchand, ni d'une facture fiscale.</p><table><thead><tr><th>Tracking</th><th>Ville</th><th>Livré le</th><th class="right">COD</th><th class="right">Frais</th><th>Encaissement</th><th>Versement</th></tr></thead><tbody>${deliveries.map(d=>`<tr><td>${esc(d.tracking)}</td><td>${esc(d.city)}</td><td>${esc(d.deliveredAt?.slice(0,16).replace('T',' '))}</td><td class="right">${cash(d.codCentimes)}</td><td class="right">${d.feeCentimes===null?'À définir':cash(d.feeCentimes)}</td><td>${d.collected?'Confirmé':'À encaisser'}</td><td>${esc(d.statementStatus||'Non rapproché')}</td></tr>`).join('')}</tbody></table><div class="totals"><p>Livraisons <strong>${deliveries.length}</strong></p><p>COD total <strong>${cash(gross)}</strong></p><p>COD encaissé confirmé <strong>${cash(collected)}</strong></p><p>Tarifs manquants <strong>${unknown}</strong></p></div>${unknown?'<p class="warning">Certains tarifs sont manquants. Aucun montant net de versement n’est calculé sans accord tarifaire.</p>':''}<p class="muted">Généré par TransitFlow · Montants à rapprocher du relevé de règlement validé.</p></body></html>`;
}
function printStatement(ctx,merchantId,statementId){
 const st=ctx.stmt(`SELECT ms.*,m.name AS merchant_name,c.name AS company_name FROM merchant_statements ms
 JOIN merchants m ON m.id=ms.merchant_id AND m.company_id=ms.company_id
 JOIN company c ON c.id=ms.company_id WHERE ms.id=? AND ms.company_id=? AND ms.merchant_id=?`,statementId,ctx.companyId,merchantId);
 if(!st)throw bad(404,'Relevé introuvable');
 const lines=ctx.all(`SELECT tracking,city,delivered_at,cod_centimes,fee_centimes,net_centimes
 FROM merchant_statement_lines WHERE statement_id=? AND company_id=? ORDER BY delivered_at,tracking`,st.id,ctx.companyId);
 const cash=n=>(n/100).toLocaleString('fr-MA',{minimumFractionDigits:2,maximumFractionDigits:2})+' MAD';
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relevé ${esc(st.reference)}</title><style>body{font:14px Arial,sans-serif;color:#1f2937;margin:30px}header{display:flex;justify-content:space-between;border-bottom:3px solid #2563eb;padding-bottom:20px}h1{margin:0}.muted{color:#64748b}table{border-collapse:collapse;width:100%;margin-top:26px}td,th{padding:12px 8px;border-bottom:1px solid #dbe2eb;text-align:left}th{background:#f1f5f9}.right{text-align:right}strong{color:#111827}.totals{max-width:380px;margin:25px 0 25px auto}.row{display:flex;justify-content:space-between;padding:7px}.foot{margin-top:35px;color:#64748b;font-size:12px}.action{margin:20px 0}@media print{.action{display:none}body{margin:12mm}}</style></head><body><button class="action" onclick="window.print()">Imprimer / Enregistrer en PDF</button><header><div><h1>TransitFlow</h1><p class="muted">Relevé des livraisons et règlement marchand</p><p><strong>${esc(st.company_name)}</strong></p></div><div class="right"><strong>${esc(st.reference)}</strong><p>${esc(st.service_date)}</p><p>${esc(st.merchant_name)}</p><p>${esc(st.status)}</p></div></header><p>Ce document détaille les colis livrés, l'encaissement COD confirmé et les frais contractuels appliqués. <strong>Ce n'est pas une facture fiscale ni une preuve de virement.</strong></p><table><thead><tr><th>Tracking</th><th>Ville</th><th>Date de livraison</th><th class="right">COD</th><th class="right">Frais</th><th class="right">Net</th></tr></thead><tbody>${lines.map(l=>`<tr><td>${esc(l.tracking)}</td><td>${esc(l.city)}</td><td>${esc(l.delivered_at?.slice(0,16).replace('T',' '))}</td><td class="right">${cash(l.cod_centimes)}</td><td class="right">${cash(l.fee_centimes)}</td><td class="right">${cash(l.net_centimes)}</td></tr>`).join('')}</tbody></table><div class="totals"><div class="row"><span>COD confirmé</span><strong>${cash(st.gross_centimes)}</strong></div><div class="row"><span>Frais de livraison</span><strong>${cash(st.fee_centimes)}</strong></div><div class="row"><span>Ajustements et solde reporté</span><strong>${cash(st.adjustment_centimes||0)}</strong></div><div class="row"><span>${st.net_centimes<0?'Solde débiteur à reporter':'Net à reverser'}</span><strong>${cash(st.net_centimes)}</strong></div></div><div class="foot">Statut: ${esc(st.status)} · Référence de virement: ${esc(st.payment_reference||'Non renseignée')} · Document généré depuis TransitFlow.</div></body></html>`;
}
export async function merchantRoute(ctx){
 const {path,method,url,req,res,user,companyId,stmt,all,run,tx,audit,send,json,createShipment}=ctx;
 const merchantPath=path.startsWith('/api/merchant/');
 if(merchantPath&&!['MERCHANT','ADMIN','FINANCE'].includes(user.role))throw bad(403,'Accès non autorisé');
 if(method==='GET'&&path==='/api/merchant/overview'){
  const merchantId=scopedMerchant(ctx,url.searchParams.get('merchantId'));return send(res,200,overview(ctx,merchantId,url.searchParams));
 }
 if(method==='GET'&&path==='/api/merchant/stock'){
  const merchantId=scopedMerchant(ctx,url.searchParams.get('merchantId'));return send(res,200,stockRows(ctx,merchantId));
 }
 if(method==='GET'&&path==='/api/merchant/deliveries/print'){
  const merchantId=scopedMerchant(ctx,url.searchParams.get('merchantId'));
  const html=printDeliveryReport(ctx,merchantId,url.searchParams);
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(html);
 }
 if(method==='GET'&&path==='/api/merchant/statements'){
  const merchantId=scopedMerchant(ctx,url.searchParams.get('merchantId'));return send(res,200,{statements:statementList(ctx,merchantId)});
 }
 const print=path.match(/^\/api\/merchant\/statements\/([a-f0-9-]{36})\/print$/);
 if(method==='GET'&&print){
  let merchantId=merchantRole(user)?scopedMerchant(ctx):clean(url.searchParams.get('merchantId'),40);
  if(!merchantRole(user))requireFinance(user);
  if(!merchantId)throw bad(400,'merchantId requis');
  const html=printStatement(ctx,merchantId,print[1]);
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(html);
 }
 if(method==='GET'&&path==='/api/finance/merchant-list'){
  requireFinance(user);return send(res,200,{merchants:all('SELECT id,name FROM merchants WHERE company_id=? ORDER BY name',companyId)});
 }
 if(method==='POST'&&path==='/api/finance/merchant-rates'){
  requireFinance(user);const data=await json(req),merchantId=scopedMerchant(ctx,data.merchantId),city=clean(data.city||'*',90).toLowerCase();
  const fee=Number(data.feeCentimes);
  if(!(city==='*'||/^[\p{L}\p{N} -]{2,90}$/u.test(city))||!Number.isSafeInteger(fee)||fee<0||fee>10000000)throw bad(400,'Ville ou tarif invalide');
  tx(()=>{
   run(`INSERT INTO merchant_rate_cards(id,company_id,merchant_id,city_key,fee_centimes,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(company_id,merchant_id,city_key) DO UPDATE SET fee_centimes=excluded.fee_centimes, updated_at=excluded.updated_at`,randomUUID(),companyId,merchantId,city,fee,new Date().toISOString());
   audit(companyId,user.id,'MERCHANT_RATE_SET','merchant',merchantId,{city,feeCentimes:fee});
  });return send(res,200,{ok:true,city,feeCentimes:fee});
 }
 if(method==='GET'&&path==='/api/finance/merchant-rates'){
  requireFinance(user);const merchantId=scopedMerchant(ctx,url.searchParams.get('merchantId'));
  return send(res,200,{rates:all('SELECT city_key AS city,fee_centimes AS feeCentimes,updated_at AS updatedAt FROM merchant_rate_cards WHERE company_id=? AND merchant_id=? ORDER BY city_key',companyId,merchantId)});
 }
 if(method==='POST'&&path==='/api/finance/merchant-product-owner'){
  if(user.role!=='ADMIN')throw bad(403,'Admin requis');
  const data=await json(req),productId=clean(data.productId,40),merchantId=scopedMerchant(ctx,data.merchantId);
  const product=stmt('SELECT id,merchant_id FROM inventory_products WHERE id=? AND company_id=?',productId,companyId);
  if(!product)throw bad(404,'Produit introuvable');
  if(product.merchant_id&&product.merchant_id!==merchantId)throw bad(409,'Produit déjà attribué à un autre marchand');
  const other=stmt(`SELECT 1 FROM stock_allocations a JOIN shipments s ON s.id=a.shipment_id AND s.company_id=a.company_id WHERE a.company_id=? AND a.product_id=? AND s.merchant_id IS NOT ? LIMIT 1`,companyId,productId,merchantId);
  if(other)throw bad(409,'Produit déjà réservé à un autre marchand');
  try{tx(()=>{run('UPDATE inventory_products SET merchant_id=? WHERE company_id=? AND id=?',merchantId,companyId,productId);audit(companyId,user.id,'PRODUCT_MERCHANT_ASSIGNED','product',productId,{merchantId});});}catch(e){if(String(e).includes('UNIQUE'))throw bad(409,'Ce marchand possède déjà ce SKU ou ce code-barres');throw e;}
  return send(res,200,{ok:true,productId,merchantId});
 }
 if(method==='POST'&&path==='/api/finance/merchant-statements'){
  requireFinance(user);const data=await json(req),merchantId=scopedMerchant(ctx,data.merchantId);
  const day=clean(data.date,10);
  if(!dateRegex.test(day)||!Number.isFinite(Date.parse(day+'T12:00:00Z')))throw bad(400,'Date requise (AAAA-MM-JJ)');
  const window=businessWindow(new URLSearchParams({period:'date',date:day}));
  if(stmt('SELECT 1 FROM merchant_statements WHERE company_id=? AND merchant_id=? AND service_date=?',companyId,merchantId,day))throw bad(409,'Relevé déjà généré pour cette date');
  const delivered=deliveredRows(ctx,merchantId,window),uncollected=delivered.filter(x=>x.codCentimes>0&&!x.collected),unpriced=delivered.filter(x=>x.feeCentimes===null),previous=delivered.filter(x=>x.statementId);
  if(uncollected.length||unpriced.length||previous.length)throw bad(409,`Relevé bloqué : ${uncollected.length} COD non encaissés, ${unpriced.length} tarifs manquants, ${previous.length} colis déjà rapprochés`);
  const adjustments=all('SELECT * FROM merchant_adjustments WHERE merchant_id=? AND company_id=? AND applied_statement_id IS NULL AND created_at<?',merchantId,companyId,window.end);
  const carries=all("SELECT * FROM merchant_statements WHERE merchant_id=? AND company_id=? AND status='APPROVED' AND net_centimes<0 AND carried_to_statement_id IS NULL AND service_date<?",merchantId,companyId,day);
  if(!delivered.length&&!adjustments.length&&!carries.length)throw bad(409,'Aucune livraison ou écriture éligible');
  const adjustmentTotal=adjustments.reduce((n,a)=>n+a.amount_centimes,0)+carries.reduce((n,c)=>n+c.net_centimes,0);
  const total=delivered.reduce((s,x)=>s+x.codCentimes,0),fees=delivered.reduce((s,x)=>s+x.feeCentimes,0);
  const statementId=randomUUID(),reference=`REL-${day.replaceAll('-','')}-${randomUUID().slice(0,6).toUpperCase()}`;
  try{tx(()=>{
   run(`INSERT INTO merchant_statements(id,company_id,merchant_id,reference,service_date,status,shipment_count,gross_centimes,fee_centimes,net_centimes,created_at,created_by,adjustment_centimes) VALUES(?,?,?,?,?,'DRAFT',?,?,?,?,?,?,?)`,statementId,companyId,merchantId,reference,day,delivered.length,total,fees,total-fees+adjustmentTotal,new Date().toISOString(),user.id,adjustmentTotal);
   for(const x of delivered)run(`INSERT INTO merchant_statement_lines(id,company_id,statement_id,shipment_id,tracking,city,delivered_at,cod_centimes,fee_centimes,net_centimes) VALUES(?,?,?,?,?,?,?,?,?,?)`,randomUUID(),companyId,statementId,x.id,x.tracking,x.city,x.deliveredAt,x.codCentimes,x.feeCentimes,x.codCentimes-x.feeCentimes);
   for(const a of adjustments){run('INSERT INTO statement_adjustment_lines VALUES(?,?,?,?,?)',companyId,statementId,a.id,a.amount_centimes,a.reference+' — '+a.note);run('UPDATE merchant_adjustments SET applied_statement_id=? WHERE id=? AND company_id=?',statementId,a.id,companyId);}
   for(const c of carries){run('INSERT INTO statement_carry_lines VALUES(?,?,?,?)',companyId,statementId,c.id,c.net_centimes);run('UPDATE merchant_statements SET carried_to_statement_id=? WHERE id=? AND company_id=?',statementId,c.id,companyId);}
   audit(companyId,user.id,'MERCHANT_STATEMENT_CREATED','merchant_statement',statementId,{merchantId,day,reference,shipments:delivered.length,total,fees});
  });}catch(e){if(String(e).includes('UNIQUE'))throw bad(409,'Relevé ou colis déjà inclus');throw e;}
  return send(res,201,{id:statementId,reference,status:'DRAFT',netCentimes:total-fees+adjustmentTotal});
 }
 const confirm=path.match(/^\/api\/finance\/merchant-statements\/([a-f0-9-]{36})\/(confirm|mark-paid)$/);
 if(method==='POST'&&confirm){
  requireFinance(user);const statementId=confirm[1],action=confirm[2],st=stmt('SELECT * FROM merchant_statements WHERE id=? AND company_id=?',statementId,companyId);
  if(!st)throw bad(404,'Relevé introuvable');
  const data=await json(req);
  if(action==='confirm'){
   if(st.status!=='DRAFT')throw bad(409,'Relevé non brouillon');
   tx(()=>{run("UPDATE merchant_statements SET status='APPROVED',confirmed_at=? WHERE company_id=? AND id=?",new Date().toISOString(),companyId,statementId);audit(companyId,user.id,'MERCHANT_STATEMENT_APPROVED','merchant_statement',statementId);});
  }else{
   const ref=clean(data.paymentReference,100);
   if(st.status!=='APPROVED')throw bad(409,'Validation comptable requise avant versement');
   if(st.net_centimes<0||st.carried_to_statement_id)throw bad(409,'Solde débiteur à reporter : aucun versement négatif autorisé');
   if(ref.length<5)throw bad(400,'Référence de versement requise');
   tx(()=>{run("UPDATE merchant_statements SET status='PAID',paid_at=?,payment_reference=? WHERE company_id=? AND id=?",new Date().toISOString(),ref,companyId,statementId);audit(companyId,user.id,'MERCHANT_PAYOUT_CONFIRMED','merchant_statement',statementId,{reference:ref,netCentimes:st.net_centimes});});
  }
  return send(res,200,{ok:true,status:action==='confirm'?'APPROVED':'PAID'});
 }
 if(method==='POST'&&path==='/api/merchant/orders'){
  if(!merchantRole(user))throw bad(403,'Réservé au marchand');
  const data=await json(req),items=data.items===undefined?[]:data.items;
  if(!Array.isArray(items)||items.length>20)throw bad(400,'Liste de produits invalide');
  if(!user.merchant_id)throw bad(403,'Marchand non associé');
  const result=tx(()=>{
   const shipment=createShipment(user,data);
   audit(companyId,user.id,'MERCHANT_ORDER_CREATED','shipment',shipment.id,{items});
   return shipment;
  });return send(res,201,result);
 }
 throw bad(404,'Route inconnue');
}
