import {setCustody} from './custody.mjs';
import {stockMovement} from './stock-ledger.mjs';
import {pickingDetail} from './warehouse.mjs';
import { randomBytes } from 'node:crypto';
import { id,now } from './db.mjs';
import {has,requirePermission,requireAgency,agencyScoped} from './access.mjs';
import {pickupReceived} from './workflow-shared.mjs';
import { centimes,cityKey,STATUS_LABELS } from './domain.mjs';
import { makeKey,hashKey } from './auth.mjs';
import { xlsx,orderColumns } from './excel.mjs';

const clean=(value,max=160)=>String(value??'').trim().slice(0,max);
const bad=(status,message)=>Object.assign(new Error(message),{status});
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const operations=user=>requirePermission(user,'warehouse','dispatch','dispatch.read','agencies');
const admin=user=>{if(user.role!=='ADMIN')throw bad(403,'Admin requis');};

export function reserveItems(ctx,shipment,items){
 const {stmt,all,run,companyId}=ctx;
 if(!Array.isArray(items)||!items.length||items.length>20)throw bad(400,'Une commande stock nécessite de 1 à 20 produits');
 const normalized=items.map(x=>({productId:clean(x?.productId,40),quantity:Number(x?.quantity)}));
 if(normalized.some(x=>!x.productId||!Number.isSafeInteger(x.quantity)||x.quantity<1||x.quantity>100000)||new Set(normalized.map(x=>x.productId)).size!==normalized.length)throw bad(400,'Produits ou quantités invalides');
 for(const item of normalized){
  const product=stmt('SELECT id,merchant_id FROM inventory_products WHERE id=? AND company_id=?',item.productId,companyId);
  if(!product||product.merchant_id!==shipment.merchant_id)throw bad(404,'Produit absent du stock de ce marchand');
  const lots=all('SELECT * FROM stock_lots WHERE company_id=? AND product_id=? AND quantity_on_hand>quantity_reserved ORDER BY received_at,id',companyId,product.id);
  if(lots.reduce((n,l)=>n+l.quantity_on_hand-l.quantity_reserved,0)<item.quantity)throw bad(409,'Stock insuffisant pour '+product.id);
  let remaining=item.quantity;
  for(const lot of lots){if(!remaining)break;const quantity=Math.min(remaining,lot.quantity_on_hand-lot.quantity_reserved);
   run('UPDATE stock_lots SET quantity_reserved=quantity_reserved+? WHERE id=? AND company_id=?',quantity,lot.id,companyId);
   const allocationId=id();run('INSERT INTO stock_allocations VALUES(?,?,?,?,?,?,?,?)',allocationId,companyId,shipment.id,product.id,lot.id,quantity,'RESERVED',now());stockMovement(ctx,{productId:product.id,lotId:lot.id,kind:'RESERVE',reserved:quantity,entityType:'shipment',entityId:shipment.id,eventKey:'RESERVE:'+allocationId});remaining-=quantity;
  }
 }
 return normalized;
}

function scanValue(value){
 let scan=clean(value,500);
 if(/^https?:\/\//i.test(scan)){try{scan=new URL(scan).pathname.split('/').filter(Boolean).at(-1)||'';}catch{throw bad(400,'Code de scan invalide');}}
 if(!/^[A-Za-z0-9_-]{4,64}$/.test(scan))throw bad(400,'Scannez le tracking ou l’ID du colis');
 return scan;
}
function scannedShipment(ctx,value){
 const scan=scanValue(value);
 const matches=ctx.all('SELECT * FROM shipments WHERE company_id=? AND (id=? OR tracking=? COLLATE NOCASE) LIMIT 2',ctx.companyId,scan,scan);
 if(!matches.length)throw bad(404,'Colis introuvable');
 if(matches.length!==1)throw bad(409,'Code ambigu entre un ID et un tracking : utilisez le tracking imprimé du colis');
 return matches[0];
}
function container(ctx,dispatchId){
 const dispatch=ctx.stmt(`SELECT d.*,a.name AS agency_name FROM dispatches d JOIN agencies a ON a.id=d.agency_id AND a.company_id=d.company_id WHERE d.id=? AND d.company_id=?`,dispatchId,ctx.companyId);
 if(!dispatch)throw bad(404,'Container introuvable');return dispatch;
}
function containerItems(ctx,dispatchId){return ctx.all(`SELECT i.shipment_id AS id,s.tracking,s.recipient,s.phone,s.address,s.description,s.city,s.status,s.agency_id,s.ramassed_at,s.order_source,s.cod_centimes,i.scanned_at
 FROM dispatch_items i JOIN shipments s ON s.id=i.shipment_id AND s.company_id=i.company_id WHERE i.dispatch_id=? AND i.company_id=? ORDER BY i.scanned_at IS NULL DESC,s.created_at,s.tracking`,dispatchId,ctx.companyId);}
function containerDetail(ctx,dispatchId){const dispatch=container(ctx,dispatchId),items=containerItems(ctx,dispatchId),scanned=items.filter(x=>x.scanned_at).length;return {dispatch,items,summary:{expected:items.length,scanned,missing:items.length-scanned}};}
function validateContents(dispatch,items){
 if(!items.length)throw bad(409,'Container vide');
 if(items.some(s=>!s.scanned_at))throw bad(409,'Container incomplet : des colis attendus ne sont pas scannés');
 if(items.some(s=>cityKey(s.city)!==dispatch.city_key||s.agency_id!==dispatch.agency_id||!['PICKED_UP','IN_TRANSIT'].includes(s.status)||!s.ramassed_at))throw bad(409,'Le contenu du container a changé : vérifiez les colis');
}
function event(ctx,shipment,status,note,source='WAREHOUSE'){
 const t=now();ctx.run('UPDATE shipments SET status=?,updated_at=? WHERE id=? AND company_id=?',status,t,shipment.id,ctx.companyId);
 ctx.run('INSERT INTO shipment_events(id,company_id,shipment_id,status,source,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)',id(),ctx.companyId,shipment.id,status,source,note,ctx.user.id,t);
}

export async function logisticsRoute(ctx){
 const {path,method,url,req,res,user,companyId,stmt,all,run,tx,audit,send,json}=ctx;
 if(method==='GET'&&path==='/api/cities')return send(res,200,{cities:all('SELECT city FROM agencies WHERE company_id=? ORDER BY city',companyId).map(x=>x.city)});
 operations(user);
 if(method==='GET'&&path==='/api/agencies')return send(res,200,{agencies:all("SELECT a.id,a.name,a.city,a.kind,a.operator_name,a.contact,a.fee_centimes,a.created_at,(SELECT COUNT(*) FROM shipments s WHERE s.company_id=a.company_id AND s.agency_id=a.id AND s.status='PICKED_UP' AND s.ramassed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dispatch_items i WHERE i.company_id=s.company_id AND i.shipment_id=s.id)) AS ready_count FROM agencies a WHERE a.company_id=?"+(agencyScoped(user)?' AND a.id=?':'')+' ORDER BY a.city',...agencyScoped(user)?[companyId,user.agency_id||'NO_AGENCY']:[companyId])});
 if(method==='POST'&&path==='/api/agencies'){
  admin(user);const data=await json(req),name=clean(data.name,120),city=clean(data.city,90),kind=data.kind||'PARTNER',fee=centimes(data.fee??0);
  if(!name||city.length<2||!['INTERNAL','PARTNER'].includes(kind))throw bad(400,'Nom, ville et type d’agence requis');
  const agencyId=id(),key=makeKey();
  try{tx(()=>{run(`INSERT INTO agencies(id,company_id,name,cities,contact,fee_centimes,api_key_hash,created_at,city,city_key,kind,operator_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,agencyId,companyId,name,JSON.stringify([city]),clean(data.contact,120),fee,hashKey(key),now(),city,cityKey(city),kind,clean(data.operatorName,120));audit(companyId,user.id,'AGENCY_CREATED','agency',agencyId,{name,city,kind,fee});});}
  catch(e){if(String(e).includes('UNIQUE'))throw bad(409,'Cette ville ou ce nom d’agence existe déjà');throw e;}
  return send(res,201,{id:agencyId,name,city,feeCentimes:fee,apiKey:key});
 }
 const agencyMatch=path.match(/^\/api\/agencies\/([a-f0-9-]{36})(?:\/(rotate-key|status-map))?$/);
 if(agencyMatch){
  admin(user);const agency=stmt('SELECT * FROM agencies WHERE id=? AND company_id=?',agencyMatch[1],companyId);if(!agency)throw bad(404,'Agence introuvable');
  const data=await json(req);
  if(method==='PATCH'&&!agencyMatch[2]){
   const fields=Object.keys(data);if(!fields.length||fields.some(x=>!['name','fee','contact','operatorName'].includes(x)))throw bad(400,'La ville est fixe ; seuls le nom, le tarif et le contact peuvent être modifiés');
   const name=data.name===undefined?agency.name:clean(data.name,120),fee=data.fee===undefined?agency.fee_centimes:centimes(data.fee);
   if(!name)throw bad(400,'Nom requis');
   try{tx(()=>{run('UPDATE agencies SET name=?,fee_centimes=?,contact=?,operator_name=? WHERE id=? AND company_id=?',name,fee,data.contact===undefined?agency.contact:clean(data.contact,120),data.operatorName===undefined?agency.operator_name:clean(data.operatorName,120),agency.id,companyId);audit(companyId,user.id,'AGENCY_UPDATED','agency',agency.id,{fields});});}catch(e){if(String(e).includes('UNIQUE'))throw bad(409,'Nom d’agence déjà utilisé');throw e;}
   return send(res,200,{ok:true});
  }
  if(method==='POST'&&agencyMatch[2]==='rotate-key'){
   const key=makeKey();tx(()=>{run('UPDATE agencies SET api_key_hash=? WHERE id=? AND company_id=?',hashKey(key),agency.id,companyId);audit(companyId,user.id,'AGENCY_KEY_ROTATED','agency',agency.id);});return send(res,200,{apiKey:key});
  }
  if(method==='POST'&&agencyMatch[2]==='status-map'){
   if(!data.map||Array.isArray(data.map)||typeof data.map!=='object'||Object.keys(data.map).length>40)throw bad(400,'Mapping invalide');
   const mapping=Object.create(null);
   for(const [key,value] of Object.entries(data.map)){const normalized=clean(key,70).toUpperCase().replace(/[\s-]+/g,'_');if(!/^[A-ZÀ-Ÿ0-9_]{1,70}$/.test(normalized)||!Object.hasOwn(STATUS_LABELS,value))throw bad(400,'Mapping invalide');mapping[normalized]=value;}
   tx(()=>{run('UPDATE agencies SET status_map=? WHERE id=? AND company_id=?',JSON.stringify(mapping),agency.id,companyId);audit(companyId,user.id,'AGENCY_STATUS_MAP','agency',agency.id);});return send(res,200,{ok:true,mapping});
  }
 }
 if(method==='GET'&&path==='/api/operations/queue'){
  requirePermission(user,'warehouse');
  const rows=all(`SELECT s.*,m.name AS merchant_name,a.name AS agency_name,
    (SELECT i.dispatch_id FROM dispatch_items i WHERE i.company_id=s.company_id AND i.shipment_id=s.id) AS dispatch_id,
    (SELECT COUNT(*) FROM stock_allocations x WHERE x.company_id=s.company_id AND x.shipment_id=s.id AND x.state='RESERVED') AS stock_lines
    FROM shipments s LEFT JOIN merchants m ON m.id=s.merchant_id AND m.company_id=s.company_id LEFT JOIN agencies a ON a.id=s.agency_id AND a.company_id=s.company_id
    WHERE s.company_id=? AND s.status IN ('CREATED','AWAITING_PICKUP','COLLECTED','ASSIGNED_AGENCY','EXPORTED','PICKED_UP') ORDER BY s.created_at LIMIT 1000`,companyId);
  return send(res,200,{shipments:rows,limit:1000});
 }
 if(method==='POST'&&path==='/api/operations/ramassage'){
  requirePermission(user,'warehouse');
  const data=await json(req);
  const result=tx(()=>{
   const s=scannedShipment(ctx,data.scan);
   if(s.status==='PICKED_UP'&&s.ramassed_at&&!stmt("SELECT 1 FROM stock_allocations WHERE shipment_id=? AND company_id=? AND state='RESERVED'",s.id,companyId))return {ok:true,duplicate:true,tracking:s.tracking,status:s.status};
   if(!['CREATED','AWAITING_PICKUP','COLLECTED','ASSIGNED_AGENCY','EXPORTED','PICKED_UP'].includes(s.status))throw bad(409,'Ce colis ne peut plus être ramassé');
   const agency=stmt('SELECT * FROM agencies WHERE company_id=? AND id=?',companyId,s.agency_id);
   if(!agency||cityKey(s.city)!==agency.city_key)throw bad(409,'Affectez le colis à l’agence de sa ville avant le ramassage');
   if(s.hold_reason)throw bad(409,'Préparation bloquée : '+s.hold_reason);
   if(stmt("SELECT 1 FROM pickup_items WHERE shipment_id=? AND company_id=? AND active=1 AND state='EXPECTED'",s.id,companyId))throw bad(409,'Ce colis est encore attendu chez le marchand ; le ramasseur doit confirmer sa collecte');
   const allocations=all("SELECT * FROM stock_allocations WHERE company_id=? AND shipment_id=? AND state='RESERVED'",companyId,s.id);
   if(s.order_source==='STOCK'&&!allocations.length)throw bad(409,'Bon stock incomplet : aucun produit réservé');
   if(s.order_source==='STOCK'&&!pickingDetail(ctx,s.id).complete)throw bad(409,'Contrôlez chaque produit et sa quantité avant le scan du colis');
   if(s.order_source==='EXTERNAL'&&allocations.length)throw bad(409,'Source du colis incohérente avec le stock');
   for(const a of allocations){run('UPDATE stock_lots SET quantity_on_hand=quantity_on_hand-?,quantity_reserved=quantity_reserved-? WHERE id=? AND company_id=?',a.quantity,a.quantity,a.lot_id,companyId);run("UPDATE stock_allocations SET state='DISPATCHED' WHERE id=? AND company_id=?",a.id,companyId);stockMovement(ctx,{productId:a.product_id,lotId:a.lot_id,kind:'DISPATCH',physical:-a.quantity,reserved:-a.quantity,entityType:'shipment',entityId:s.id,eventKey:'DISPATCH:'+a.id});}
   run('UPDATE shipments SET ramassed_at=? WHERE id=? AND company_id=?',now(),s.id,companyId);event(ctx,s,'PICKED_UP','Scan ramassage — '+(s.order_source==='STOCK'?'préparation stock confirmée':'colis externe réceptionné'));
   setCustody(ctx,s,'WAREHOUSE',{scan:true});pickupReceived(ctx,s);
   audit(companyId,user.id,'RAMASSAGE_SCANNED','shipment',s.id,{source:s.order_source,stockAllocations:allocations.length});
   return {ok:true,tracking:s.tracking,status:'PICKED_UP',source:s.order_source,city:s.city};
  });return send(res,200,result);
 }
 const prep=path.match(/^\/api\/shipments\/([a-f0-9-]{36})\/preparation$/);
 if(method==='GET'&&prep){
  requirePermission(user,'warehouse');
  const s=stmt('SELECT s.*,m.name AS merchant_name FROM shipments s LEFT JOIN merchants m ON m.id=s.merchant_id AND m.company_id=s.company_id WHERE s.id=? AND s.company_id=?',prep[1],companyId);if(!s)throw bad(404,'Colis introuvable');
  const lines=all(`SELECT p.sku,p.name,l.location,SUM(a.quantity) AS quantity,a.state FROM stock_allocations a JOIN inventory_products p ON p.id=a.product_id AND p.company_id=a.company_id JOIN stock_lots l ON l.id=a.lot_id AND l.company_id=a.company_id WHERE a.shipment_id=? AND a.company_id=? AND a.state<>'RELEASED' GROUP BY p.id,l.location,a.state`,s.id,companyId);
  const html=`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Bon ${s.order_source==='STOCK'?'stock':'de livraison'} ${esc(s.tracking)}</title><style>body{font:15px Arial;margin:30px;color:#18273e}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:12px;text-align:left}.tracking{font:700 24px monospace}</style><h1>Bon ${s.order_source==='STOCK'?'stock — préparation warehouse':'de livraison — colis externe'}</h1><p class="tracking">${esc(s.tracking)}</p><p>ID : ${esc(s.id)}</p><p>Marchand : ${esc(s.merchant_name||'—')}</p><p>Destinataire : ${esc(s.recipient)} · ${esc(s.phone)}</p><p>Adresse : ${esc(s.address)} · ${esc(s.city)}</p>${s.order_source==='STOCK'?`<table><thead><tr><th>SKU</th><th>Produit</th><th>Emplacement</th><th>Quantité</th><th>État</th></tr></thead><tbody>${lines.map(l=>`<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td>${esc(l.location)}</td><td>${l.quantity}</td><td>${esc(l.state)}</td></tr>`).join('')}</tbody></table>`:'<p>Colis à réceptionner du marchand. Aucun prélèvement dans le stock warehouse.</p>'}<p>Imprimez le ticket du colis, collez-le sur le colis préparé, puis scannez le ramassage avant le tri dans le container de sa ville.</p></html>`;
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);
 }
 if(method==='GET'&&path==='/api/dispatches'){
  return send(res,200,{dispatches:all(`SELECT d.*,a.name AS agency_name,COUNT(i.shipment_id) AS expected,COUNT(i.scanned_at) AS scanned FROM dispatches d JOIN agencies a ON a.id=d.agency_id AND a.company_id=d.company_id LEFT JOIN dispatch_items i ON i.dispatch_id=d.id AND i.company_id=d.company_id WHERE d.company_id=?${agencyScoped(user)?' AND d.agency_id=?':''} GROUP BY d.id ORDER BY d.created_at DESC LIMIT 200`,...agencyScoped(user)?[companyId,user.agency_id||'NO_AGENCY']:[companyId])});
 }
 if(method==='POST'&&path==='/api/dispatches'){
  requirePermission(user,'dispatch');if(agencyScoped(user))throw bad(403,'Le départ warehouse est géré par l’exploitation centrale');
  const data=await json(req),dispatchId=id();
  const result=tx(()=>{
   const agency=stmt('SELECT * FROM agencies WHERE id=? AND company_id=?',data.agencyId,companyId);if(!agency)throw bad(404,'Agence introuvable');
   if(stmt("SELECT 1 FROM dispatches WHERE company_id=? AND agency_id=? AND state='OPEN'",companyId,agency.id))throw bad(409,'Un container est déjà ouvert pour cette ville');
   const eligible=all(`SELECT s.id FROM shipments s WHERE s.company_id=? AND s.agency_id=? AND s.status='PICKED_UP' AND s.ramassed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dispatch_items i WHERE i.company_id=s.company_id AND i.shipment_id=s.id) ORDER BY s.created_at`,companyId,agency.id);
   let ids=eligible.map(x=>x.id);
   if(data.shipmentIds!==undefined){if(!Array.isArray(data.shipmentIds)||!data.shipmentIds.length||new Set(data.shipmentIds).size!==data.shipmentIds.length||data.shipmentIds.some(x=>!ids.includes(x)))throw bad(400,'Sélection de colis invalide pour cette agence');ids=data.shipmentIds;}
   if(!ids.length)throw bad(409,'Aucun colis ramassé en attente pour cette ville');if(ids.length>2000)throw bad(400,'Maximum 2000 colis par container ; sélectionnez un lot');
   const reference=`ENV-${Date.now()}-${randomBytes(3).toString('hex').toUpperCase()}`;
   run('INSERT INTO dispatches(id,company_id,agency_id,reference,city,city_key,fee_centimes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',dispatchId,companyId,agency.id,reference,agency.city,agency.city_key,agency.fee_centimes,user.id,now());
   for(const shipId of ids)run('INSERT INTO dispatch_items(company_id,dispatch_id,shipment_id) VALUES(?,?,?)',companyId,dispatchId,shipId);
   audit(companyId,user.id,'CONTAINER_OPENED','dispatch',dispatchId,{city:agency.city,expected:ids.length});return containerDetail(ctx,dispatchId);
  });return send(res,201,result);
 }
 const dispatchMatch=path.match(/^\/api\/dispatches\/([a-f0-9-]{36})(?:\/(scan|close|ship|export|cancel))?$/);
 if(dispatchMatch){
  const dispatchId=dispatchMatch[1],action=dispatchMatch[2],d=container(ctx,dispatchId);requireAgency(user,d.agency_id);if(method!=='GET'){requirePermission(user,'dispatch');if(agencyScoped(user))throw bad(403,'Le départ warehouse est géré par l’exploitation centrale');}
  if(method==='GET'&&!action)return send(res,200,containerDetail(ctx,dispatchId));
  if(method==='POST'&&action==='scan'){
   const data=await json(req);
   const result=tx(()=>{
    const current=container(ctx,dispatchId);if(current.state!=='OPEN')throw bad(409,'Ce container n’est plus ouvert');
    const s=scannedShipment(ctx,data.scan);
    if(cityKey(s.city)!==current.city_key||s.agency_id!==current.agency_id)throw bad(409,`Mauvaise ville : colis pour ${s.city}, container ${current.city}`);
    if(!['PICKED_UP','IN_TRANSIT'].includes(s.status)||!s.ramassed_at)throw bad(409,'Scannez d’abord le ramassage de ce colis');
    const item=stmt('SELECT * FROM dispatch_items WHERE company_id=? AND shipment_id=?',companyId,s.id);
    if(!item)throw bad(409,'Colis non attendu dans ce bon d’envoi ; il a été ramassé après l’ouverture ou appartient à un autre lot');
    if(item.dispatch_id!==dispatchId)throw bad(409,'Colis déjà affecté à un autre container');
    if(item.scanned_at)throw bad(409,'Colis déjà scanné dans ce container');
    run('UPDATE dispatch_items SET scanned_at=?,scanned_by=? WHERE dispatch_id=? AND shipment_id=? AND company_id=?',now(),user.id,dispatchId,s.id,companyId);
    event(ctx,s,'IN_TRANSIT',current.reference+' — scanné dans le bon d’envoi vers '+current.city,'DISPATCH');setCustody(ctx,s,'OUTBOUND',{agencyId:current.agency_id,scan:true});
    audit(companyId,user.id,'CONTAINER_PARCEL_SCANNED','dispatch',dispatchId,{shipmentId:s.id,tracking:s.tracking});return {...containerDetail(ctx,dispatchId),acceptedTracking:s.tracking};
   });return send(res,200,result);
  }
  if(method==='POST'&&action==='close'){
   await json(req);const result=tx(()=>{const current=container(ctx,dispatchId);if(current.state!=='OPEN')throw bad(409,'Container non ouvert');validateContents(current,containerItems(ctx,dispatchId));run("UPDATE dispatches SET state='CLOSED',closed_at=? WHERE id=? AND company_id=?",now(),dispatchId,companyId);audit(companyId,user.id,'CONTAINER_CLOSED','dispatch',dispatchId);return containerDetail(ctx,dispatchId);});return send(res,200,result);
  }
  if(method==='POST'&&action==='cancel'){
   const data=await json(req),reason=clean(data.reason,200);if(reason.length<5)throw bad(400,'Motif d’annulation requis');
   tx(()=>{const current=container(ctx,dispatchId);if(!['OPEN','CLOSED'].includes(current.state))throw bad(409,'Container déjà expédié ou annulé');for(const s of containerItems(ctx,dispatchId)){if(s.scanned_at&&s.status==='IN_TRANSIT'){event(ctx,s,'PICKED_UP','Envoi annulé — '+reason,'DISPATCH');setCustody(ctx,s,'WAREHOUSE');}}run('DELETE FROM dispatch_items WHERE dispatch_id=? AND company_id=?',dispatchId,companyId);run("UPDATE dispatches SET state='CANCELLED' WHERE id=? AND company_id=?",dispatchId,companyId);audit(companyId,user.id,'CONTAINER_CANCELLED','dispatch',dispatchId,{reason});});return send(res,200,{ok:true});
  }
  if(method==='POST'&&action==='ship'){
   await json(req);const result=tx(()=>{const current=container(ctx,dispatchId);if(current.state!=='CLOSED')throw bad(409,'Fermez le container complet avant de confirmer son départ');const items=containerItems(ctx,dispatchId);validateContents(current,items);
    run("UPDATE dispatches SET state='SHIPPED',shipped_at=? WHERE id=? AND company_id=?",now(),dispatchId,companyId);
    for(const s of items){event(ctx,s,'IN_TRANSIT',current.reference+' — départ vers '+current.city,'DISPATCH');run('UPDATE shipments SET handed_over_at=?,agency_fee_centimes=? WHERE id=? AND company_id=?',now(),current.fee_centimes,s.id,companyId);}
    audit(companyId,user.id,'CONTAINER_SHIPPED','dispatch',dispatchId,{shipments:items.length});return containerDetail(ctx,dispatchId);
   });return send(res,200,result);
  }
  if(method==='POST'&&action==='export'){
   await json(req);if(!['CLOSED','SHIPPED'].includes(d.state))throw bad(409,'Fermez le container après scan de tous les colis avant de générer l’Excel');
   const items=containerItems(ctx,dispatchId);if(!items.length||items.some(x=>!x.scanned_at))throw bad(409,'Container incomplet');
   const bytes=xlsx('export',[orderColumns,...items.map(s=>[s.tracking,s.recipient,s.phone,s.address,s.city,(s.cod_centimes/100).toFixed(2),s.description])]);
   audit(companyId,user.id,'CONTAINER_EXCEL_EXPORTED','dispatch',dispatchId,{count:items.length});res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${d.reference}.xlsx"`,'Cache-Control':'no-store'});return res.end(bytes);
  }
 }
 throw bad(404,'Route logistique introuvable');
}
