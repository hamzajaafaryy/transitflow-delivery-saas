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
 const {stmt,tenant,user}=ctx;
 if(merchantRole(user)){
  if(!user.merchant_id||requested&&requested!==user.merchant_id)throw bad(403,'Marchand non autorisé');
  return user.merchant_id;
 }
 requireFinance(user);
 const merchantId=clean(requested,40);
 if(!merchantId)throw bad(400,'merchantId requis');
 if(!stmt('SELECT 1 FROM merchants WHERE id=? AND tenant_id=?',merchantId,tenant))throw bad(404,'Marchand introuvable');
 return merchantId;
}
function findRate(ctx,merchantId,city){
 const key=clean(city,90).toLowerCase();
 return ctx.stmt(`SELECT fee_centimes,city_key FROM merchant_rate_cards
  WHERE tenant_id=? AND merchant_id=? AND city_key IN (?, '*') ORDER BY CASE WHEN city_key=? THEN 0 ELSE 1 END LIMIT 1`,ctx.tenant,merchantId,key,key);
}
function stockRows(ctx,merchantId){
 const products=ctx.all(`SELECT p.id,p.sku,p.name,
 COALESCE(SUM(l.quantity_on_hand),0) AS onHand,
 COALESCE(SUM(l.quantity_reserved),0) AS reserved
 FROM inventory_products p LEFT JOIN stock_lots l ON l.product_id=p.id AND l.tenant_id=p.tenant_id
 WHERE p.tenant_id=? AND p.merchant_id=? GROUP BY p.id ORDER BY p.name,p.sku`,ctx.tenant,merchantId)
 .map(p=>({...p,available:p.onHand-p.reserved}));
 const warehouses=ctx.all(`SELECT p.id AS productId,p.sku,p.name,l.location AS warehouse,
 SUM(l.quantity_on_hand) AS onHand,SUM(l.quantity_reserved) AS reserved,COUNT(*) AS lots
 FROM inventory_products p JOIN stock_lots l ON l.product_id=p.id AND l.tenant_id=p.tenant_id
 WHERE p.tenant_id=? AND p.merchant_id=? GROUP BY p.id,l.location ORDER BY p.name,l.location`,ctx.tenant,merchantId)
 .map(w=>({...w,available:w.onHand-w.reserved}));
 const lots=ctx.all(`SELECT p.sku,p.name,l.id,l.location AS warehouse,l.received_at AS receivedAt,
 l.quantity_on_hand AS onHand,l.quantity_reserved AS reserved, l.quantity_on_hand-l.quantity_reserved AS available
 FROM inventory_products p JOIN stock_lots l ON l.product_id=p.id AND l.tenant_id=p.tenant_id
 WHERE p.tenant_id=? AND p.merchant_id=? ORDER BY l.received_at DESC LIMIT 300`,ctx.tenant,merchantId);
 const allocations=ctx.all(`SELECT s.tracking,s.status,p.sku,p.name,a.quantity,a.state,a.created_at AS createdAt,l.location AS warehouse
 FROM stock_allocations a JOIN inventory_products p ON p.id=a.product_id AND p.tenant_id=a.tenant_id
 JOIN shipments s ON s.id=a.shipment_id AND s.tenant_id=a.tenant_id
 JOIN stock_lots l ON l.id=a.lot_id AND l.tenant_id=a.tenant_id
 WHERE a.tenant_id=? AND p.merchant_id=? AND s.merchant_id=? ORDER BY a.created_at DESC LIMIT 120`,ctx.tenant,merchantId,merchantId);
 return {products,warehouses,lots,allocations,summary:{skuCount:products.length,unitsPhysical:products.reduce((a,p)=>a+p.onHand,0),unitsReserved:products.reduce((a,p)=>a+p.reserved,0),unitsAvailable:products.reduce((a,p)=>a+p.available,0)}};
}
function deliveredRows(ctx,merchantId,window){
 const rows=ctx.all(`SELECT s.id,s.tracking,s.recipient,s.city,s.status,s.cod_centimes AS codCentimes,
 s.delivered_at AS deliveredAt,s.created_at AS createdAt,s.description,
 p.name AS partnerName,
 EXISTS(SELECT 1 FROM ledger l WHERE l.tenant_id=s.tenant_id AND l.shipment_id=s.id AND l.type='COD_COLLECTED') AS collected,
 sl.statement_id AS statementId,ms.status AS statementStatus
 FROM shipments s LEFT JOIN partners p ON p.id=s.partner_id AND p.tenant_id=s.tenant_id
 LEFT JOIN merchant_statement_lines sl ON sl.tenant_id=s.tenant_id AND sl.shipment_id=s.id
 LEFT JOIN merchant_statements ms ON ms.tenant_id=s.tenant_id AND ms.id=sl.statement_id
 WHERE s.tenant_id=? AND s.merchant_id=? AND s.status='DELIVERED' AND s.delivered_at>=? AND s.delivered_at<?
 ORDER BY s.delivered_at DESC`,ctx.tenant,merchantId,window.start,window.end);
 return rows.map(s=>{
  const rate=findRate(ctx,merchantId,s.city);
  return {...s,collected:Boolean(s.collected),feeCentimes:rate?.fee_centimes??null,
   estimatedNetCentimes:rate?Math.max(0,s.codCentimes-rate.fee_centimes):null,
   feeSource:rate?.city_key??null};
 });
}
function statementList(ctx,merchantId){
 return ctx.all(`SELECT id,reference,service_date AS serviceDate,status,shipment_count AS shipmentCount,
 gross_centimes AS grossCentimes,fee_centimes AS feeCentimes,net_centimes AS netCentimes,
 created_at AS createdAt,confirmed_at AS confirmedAt,paid_at AS paidAt,payment_reference AS paymentReference
 FROM merchant_statements WHERE tenant_id=? AND merchant_id=? ORDER BY service_date DESC,created_at DESC LIMIT 120`,ctx.tenant,merchantId);
}
function overview(ctx,merchantId,params){
 const window=businessWindow(params),merchant=ctx.stmt('SELECT id,name,phone FROM merchants WHERE id=? AND tenant_id=?',merchantId,ctx.tenant);
 if(!merchant)throw bad(404,'Marchand introuvable');
 const deliveries=deliveredRows(ctx,merchantId,window);
 const statements=statementList(ctx,merchantId);
 const summary={delivered:deliveries.length,grossDeliveredCentimes:deliveries.reduce((a,x)=>a+x.codCentimes,0),
  collected:deliveries.filter(x=>x.collected).length,
  collectedCentimes:deliveries.filter(x=>x.collected).reduce((a,x)=>a+x.codCentimes,0),
  pendingCollectionCentimes:deliveries.filter(x=>!x.collected).reduce((a,x)=>a+x.codCentimes,0),
  unpriced:deliveries.filter(x=>x.feeCentimes===null).length,
  collectedReadyForStatementCentimes:deliveries.filter(x=>x.collected&&x.feeCentimes!==null&&!x.statementId).reduce((a,x)=>a+x.estimatedNetCentimes,0),
  statementsAwaitingPaymentCentimes:statements.filter(s=>s.status!=='PAID').reduce((a,s)=>a+s.netCentimes,0),
  statementsPaidCentimes:statements.filter(s=>s.status==='PAID').reduce((a,s)=>a+s.netCentimes,0)
 };
 return {merchant,window,summary,deliveries,statements,stock:stockRows(ctx,merchantId).summary,
  warning:'Livré ne signifie pas encaissé. Les sommes « à verser » sont un suivi interne, pas un virement bancaire. Tarifs non configurés = net indisponible.'};
}
function esc(s){return String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));}
function printStatement(ctx,merchantId,statementId){
 const st=ctx.stmt(`SELECT ms.*,m.name AS merchant_name,c.name AS company_name FROM merchant_statements ms
 JOIN merchants m ON m.id=ms.merchant_id AND m.tenant_id=ms.tenant_id
 JOIN companies c ON c.id=ms.tenant_id WHERE ms.id=? AND ms.tenant_id=? AND ms.merchant_id=?`,statementId,ctx.tenant,merchantId);
 if(!st)throw bad(404,'Relevé introuvable');
 const lines=ctx.all(`SELECT tracking,city,delivered_at,cod_centimes,fee_centimes,net_centimes
 FROM merchant_statement_lines WHERE statement_id=? AND tenant_id=? ORDER BY delivered_at,tracking`,st.id,ctx.tenant);
 const cash=n=>(n/100).toLocaleString('fr-MA',{minimumFractionDigits:2,maximumFractionDigits:2})+' MAD';
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relevé ${esc(st.reference)}</title><style>body{font:14px Arial,sans-serif;color:#1f2937;margin:30px}header{display:flex;justify-content:space-between;border-bottom:3px solid #2563eb;padding-bottom:20px}h1{margin:0}.muted{color:#64748b}table{border-collapse:collapse;width:100%;margin-top:26px}td,th{padding:12px 8px;border-bottom:1px solid #dbe2eb;text-align:left}th{background:#f1f5f9}.right{text-align:right}strong{color:#111827}.totals{max-width:380px;margin:25px 0 25px auto}.row{display:flex;justify-content:space-between;padding:7px}.foot{margin-top:35px;color:#64748b;font-size:12px}.action{margin:20px 0}@media print{.action{display:none}body{margin:12mm}}</style></head><body><button class="action" onclick="window.print()">Imprimer / Enregistrer en PDF</button><header><div><h1>TransitFlow</h1><p class="muted">Relevé des livraisons et règlement marchand</p><p><strong>${esc(st.company_name)}</strong></p></div><div class="right"><strong>${esc(st.reference)}</strong><p>${esc(st.service_date)}</p><p>${esc(st.merchant_name)}</p><p>${esc(st.status)}</p></div></header><p>Ce document détaille les colis livrés, l'encaissement COD confirmé et les frais contractuels appliqués. <strong>Ce n'est pas une facture fiscale ni une preuve de virement.</strong></p><table><thead><tr><th>Tracking</th><th>Ville</th><th>Date de livraison</th><th class="right">COD</th><th class="right">Frais</th><th class="right">Net</th></tr></thead><tbody>${lines.map(l=>`<tr><td>${esc(l.tracking)}</td><td>${esc(l.city)}</td><td>${esc(l.delivered_at?.slice(0,16).replace('T',' '))}</td><td class="right">${cash(l.cod_centimes)}</td><td class="right">${cash(l.fee_centimes)}</td><td class="right">${cash(l.net_centimes)}</td></tr>`).join('')}</tbody></table><div class="totals"><div class="row"><span>COD confirmé</span><strong>${cash(st.gross_centimes)}</strong></div><div class="row"><span>Frais de livraison</span><strong>${cash(st.fee_centimes)}</strong></div><div class="row"><span>Net à reverser</span><strong>${cash(st.net_centimes)}</strong></div></div><div class="foot">Statut: ${esc(st.status)} · Référence de virement: ${esc(st.payment_reference||'Non renseignée')} · Document généré depuis TransitFlow.</div></body></html>`;
}
export async function merchantRoute(ctx){
 const {path,method,url,req,res,user,tenant,stmt,all,run,tx,audit,send,json,createShipment}=ctx;
 const merchantPath=path.startsWith('/api/merchant/');
 if(merchantPath&&!['MERCHANT','ADMIN','FINANCE'].includes(user.role))throw bad(403,'Accès non autorisé');
 if(method==='GET'&&path==='/api/merchant/overview'){
  const merchantId=scopedMerchant(ctx,url.searchParams.get('merchantId'));return send(res,200,overview(ctx,merchantId,url.searchParams));
 }
 if(method==='GET'&&path==='/api/merchant/stock'){
  const merchantId=scopedMerchant(ctx,url.searchParams.get('merchantId'));return send(res,200,stockRows(ctx,merchantId));
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
  requireFinance(user);return send(res,200,{merchants:all('SELECT id,name FROM merchants WHERE tenant_id=? ORDER BY name',tenant)});
 }
 if(method==='POST'&&path==='/api/finance/merchant-rates'){
  requireFinance(user);const data=await json(req),merchantId=scopedMerchant(ctx,data.merchantId),city=clean(data.city||'*',90).toLowerCase();
  const fee=Number(data.feeCentimes);
  if(!(city==='*'||/^[\p{L}\p{N} -]{2,90}$/u.test(city))||!Number.isSafeInteger(fee)||fee<0||fee>10000000)throw bad(400,'Ville ou tarif invalide');
  tx(()=>{
   run(`INSERT INTO merchant_rate_cards(id,tenant_id,merchant_id,city_key,fee_centimes,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(tenant_id,merchant_id,city_key) DO UPDATE SET fee_centimes=excluded.fee_centimes, updated_at=excluded.updated_at`,randomUUID(),tenant,merchantId,city,fee,new Date().toISOString());
   audit(tenant,user.id,'MERCHANT_RATE_SET','merchant',merchantId,{city,feeCentimes:fee});
  });return send(res,200,{ok:true,city,feeCentimes:fee});
 }
 if(method==='GET'&&path==='/api/finance/merchant-rates'){
  requireFinance(user);const merchantId=scopedMerchant(ctx,url.searchParams.get('merchantId'));
  return send(res,200,{rates:all('SELECT city_key AS city,fee_centimes AS feeCentimes,updated_at AS updatedAt FROM merchant_rate_cards WHERE tenant_id=? AND merchant_id=? ORDER BY city_key',tenant,merchantId)});
 }
 if(method==='POST'&&path==='/api/finance/merchant-product-owner'){
  if(user.role!=='ADMIN')throw bad(403,'Admin requis');
  const data=await json(req),productId=clean(data.productId,40),merchantId=scopedMerchant(ctx,data.merchantId);
  const product=stmt('SELECT id,merchant_id FROM inventory_products WHERE id=? AND tenant_id=?',productId,tenant);
  if(!product)throw bad(404,'Produit introuvable');
  if(product.merchant_id&&product.merchant_id!==merchantId)throw bad(409,'Produit déjà attribué à un autre marchand');
  const other=stmt(`SELECT 1 FROM stock_allocations a JOIN shipments s ON s.id=a.shipment_id AND s.tenant_id=a.tenant_id WHERE a.tenant_id=? AND a.product_id=? AND s.merchant_id IS NOT ? LIMIT 1`,tenant,productId,merchantId);
  if(other)throw bad(409,'Produit déjà réservé à un autre marchand');
  tx(()=>{run('UPDATE inventory_products SET merchant_id=? WHERE tenant_id=? AND id=?',merchantId,tenant,productId);audit(tenant,user.id,'PRODUCT_MERCHANT_ASSIGNED','product',productId,{merchantId});});
  return send(res,200,{ok:true,productId,merchantId});
 }
 if(method==='POST'&&path==='/api/finance/merchant-statements'){
  requireFinance(user);const data=await json(req),merchantId=scopedMerchant(ctx,data.merchantId);
  const day=clean(data.date,10);
  if(!dateRegex.test(day)||!Number.isFinite(Date.parse(day+'T12:00:00Z')))throw bad(400,'Date requise (AAAA-MM-JJ)');
  const window=businessWindow(new URLSearchParams({period:'date',date:day}));
  if(stmt('SELECT 1 FROM merchant_statements WHERE tenant_id=? AND merchant_id=? AND service_date=?',tenant,merchantId,day))throw bad(409,'Relevé déjà généré pour cette date');
  const delivered=deliveredRows(ctx,merchantId,window),uncollected=delivered.filter(x=>x.codCentimes>0&&!x.collected),unpriced=delivered.filter(x=>x.feeCentimes===null),previous=delivered.filter(x=>x.statementId);
  if(uncollected.length||unpriced.length||previous.length)throw bad(409,`Relevé bloqué : ${uncollected.length} COD non encaissés, ${unpriced.length} tarifs manquants, ${previous.length} colis déjà rapprochés`);
  if(!delivered.length)throw bad(409,'Aucune livraison éligible');
  const total=delivered.reduce((s,x)=>s+x.codCentimes,0),fees=delivered.reduce((s,x)=>s+x.feeCentimes,0);
  if(delivered.some(x=>x.feeCentimes>x.codCentimes))throw bad(409,'Frais supérieurs au COD sur un colis, traitement manuel requis');
  const statementId=randomUUID(),reference=`REL-${day.replaceAll('-','')}-${randomUUID().slice(0,6).toUpperCase()}`;
  try{tx(()=>{
   run(`INSERT INTO merchant_statements(id,tenant_id,merchant_id,reference,service_date,status,shipment_count,gross_centimes,fee_centimes,net_centimes,created_at,created_by) VALUES(?,?,?,?,?,'DRAFT',?,?,?,?,?,?)`,statementId,tenant,merchantId,reference,day,delivered.length,total,fees,total-fees,new Date().toISOString(),user.id);
   for(const x of delivered)run(`INSERT INTO merchant_statement_lines(id,tenant_id,statement_id,shipment_id,tracking,city,delivered_at,cod_centimes,fee_centimes,net_centimes) VALUES(?,?,?,?,?,?,?,?,?,?)`,randomUUID(),tenant,statementId,x.id,x.tracking,x.city,x.deliveredAt,x.codCentimes,x.feeCentimes,x.codCentimes-x.feeCentimes);
   audit(tenant,user.id,'MERCHANT_STATEMENT_CREATED','merchant_statement',statementId,{merchantId,day,reference,shipments:delivered.length,total,fees});
  });}catch(e){if(String(e).includes('UNIQUE'))throw bad(409,'Relevé ou colis déjà inclus');throw e;}
  return send(res,201,{id:statementId,reference,status:'DRAFT',netCentimes:total-fees});
 }
 const confirm=path.match(/^\/api\/finance\/merchant-statements\/([a-f0-9-]{36})\/(confirm|mark-paid)$/);
 if(method==='POST'&&confirm){
  requireFinance(user);const statementId=confirm[1],action=confirm[2],st=stmt('SELECT * FROM merchant_statements WHERE id=? AND tenant_id=?',statementId,tenant);
  if(!st)throw bad(404,'Relevé introuvable');
  const data=await json(req);
  if(action==='confirm'){
   if(st.status!=='DRAFT')throw bad(409,'Relevé non brouillon');
   tx(()=>{run("UPDATE merchant_statements SET status='APPROVED',confirmed_at=? WHERE tenant_id=? AND id=?",new Date().toISOString(),tenant,statementId);audit(tenant,user.id,'MERCHANT_STATEMENT_APPROVED','merchant_statement',statementId);});
  }else{
   const ref=clean(data.paymentReference,100);
   if(st.status!=='APPROVED')throw bad(409,'Validation comptable requise avant versement');
   if(ref.length<5)throw bad(400,'Référence de versement requise');
   tx(()=>{run("UPDATE merchant_statements SET status='PAID',paid_at=?,payment_reference=? WHERE tenant_id=? AND id=?",new Date().toISOString(),ref,tenant,statementId);audit(tenant,user.id,'MERCHANT_PAYOUT_CONFIRMED','merchant_statement',statementId,{reference:ref,netCentimes:st.net_centimes});});
  }
  return send(res,200,{ok:true,status:action==='confirm'?'APPROVED':'PAID'});
 }
 if(method==='POST'&&path==='/api/merchant/orders'){
  if(!merchantRole(user))throw bad(403,'Réservé au marchand');
  const data=await json(req),items=data.items===undefined?[]:data.items;
  if(!Array.isArray(items)||items.length>20)throw bad(400,'Liste de produits invalide');
  if(!user.merchant_id)throw bad(403,'Marchand non associé');
  const normalized=items.map(x=>({productId:clean(x.productId,40),quantity:Number(x.quantity)}));
  if(normalized.some(x=>!Number.isSafeInteger(x.quantity)||x.quantity<1||x.quantity>100000))throw bad(400,'Quantité invalide');
  if(new Set(normalized.map(x=>x.productId)).size!==normalized.length)throw bad(400,'Produits dupliqués');
  const result=tx(()=>{
   // Existing shipment creation validates and forcibly binds merchant_id to session.
   const shipment=createShipment(user,data);
   for(const item of normalized){
    const product=stmt('SELECT id FROM inventory_products WHERE id=? AND tenant_id=? AND merchant_id=?',item.productId,tenant,user.merchant_id);
    if(!product)throw bad(404,'Produit absent de votre stock');
    const lots=all('SELECT id,quantity_on_hand,quantity_reserved FROM stock_lots WHERE tenant_id=? AND product_id=? ORDER BY received_at,id',tenant,product.id);
    if(lots.reduce((n,l)=>n+l.quantity_on_hand-l.quantity_reserved,0)<item.quantity)throw bad(409,'Stock insuffisant');
    let remaining=item.quantity;
    for(const lot of lots){if(!remaining)break;const quantity=Math.min(remaining,lot.quantity_on_hand-lot.quantity_reserved);if(!quantity)continue;
     run('UPDATE stock_lots SET quantity_reserved=quantity_reserved+? WHERE id=? AND tenant_id=?',quantity,lot.id,tenant);
     run('INSERT INTO stock_allocations VALUES(?,?,?,?,?,?,?,?)',randomUUID(),tenant,shipment.id,product.id,lot.id,quantity,'RESERVED',new Date().toISOString());remaining-=quantity;
    }
   }
   audit(tenant,user.id,'MERCHANT_ORDER_CREATED','shipment',shipment.id,{items:normalized});
   return shipment;
  });return send(res,201,result);
 }
 throw bad(404,'Route inconnue');
}
