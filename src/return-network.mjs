import {id,now} from './db.mjs';
import {requirePermission,requireAgency,agencyScoped,shipmentScope} from './access.mjs';
import {clean,fail,reference,scanShipment,parcelEvent,notify,documentHtml,html,esc} from './workflow-shared.mjs';
import {receiveReturn,inspectReturn,completeReturn} from './returns.mjs';
import {setCustody,CUSTODY_LABELS} from './custody.mjs';

const failureStatuses=['REFUSED','CANCELLED','UNREACHABLE','DAMAGED','RETURNING'];
function validateIds(ids){if(ids!==undefined&&(!Array.isArray(ids)||ids.length>1000||ids.some(x=>typeof x!=='string')||new Set(ids).size!==ids.length))throw fail(400,'Liste de colis invalide (1 000 maximum, sans doublon)');}
function central(ctx){if(agencyScoped(ctx.user))throw fail(403,'Réception et remise marchands réservées à l’agence d’origine');requirePermission(ctx.user,'returns.receive');}
function packing(ctx){requirePermission(ctx.user,'returns.manage','returns.receive');if(['SUPPORT'].includes(ctx.user.role))throw fail(403,'Le conditionnement nécessite un compte exploitation ou agence');}
function returnRecord(ctx,s){
 const previous=ctx.stmt('SELECT * FROM parcel_returns WHERE shipment_id=? AND company_id=? AND active=1',s.id,ctx.companyId);
 if(previous){
  if(previous.kind!=='RETURN'||previous.after_delivery||!['REQUESTED','AUTHORIZED'].includes(previous.state))throw fail(409,'Ce dossier retour suit déjà un autre parcours');
  if(s.order_source==='STOCK'){
   const remaining=ctx.all(`SELECT a.id,a.quantity-COALESCE((SELECT SUM(i.quantity) FROM return_items i JOIN parcel_returns r ON r.id=i.return_id AND r.company_id=i.company_id WHERE i.allocation_id=a.id AND i.company_id=a.company_id AND i.return_id<>? AND r.state NOT IN ('REJECTED','CANCELLED')),0) AS quantity FROM stock_allocations a WHERE a.company_id=? AND a.shipment_id=? AND a.state='DISPATCHED'`,previous.id,ctx.companyId,s.id).filter(i=>i.quantity>0),lines=ctx.all('SELECT allocation_id,quantity FROM return_items WHERE return_id=? AND company_id=?',previous.id,ctx.companyId);
   if(remaining.length!==lines.length||remaining.some(a=>!lines.some(i=>i.allocation_id===a.id&&i.quantity===a.quantity)))throw fail(409,'Retour stock partiel : contrôlez les quantités dans le dossier avant un transport groupé');
  }
  if(previous.state==='REQUESTED'){ctx.run("UPDATE parcel_returns SET state='AUTHORIZED',updated_at=? WHERE id=? AND company_id=?",now(),previous.id,ctx.companyId);ctx.audit(ctx.companyId,ctx.user.id,'RETURN_DECISION','return',previous.id,{accepted:true,note:'Retour de non-livraison validé au scan du container'});}
  return {...previous,state:'AUTHORIZED'};
 }
 const allocations=ctx.all(`SELECT a.*,a.quantity-COALESCE((SELECT SUM(ri.quantity) FROM return_items ri JOIN parcel_returns r ON r.id=ri.return_id AND r.company_id=ri.company_id WHERE ri.allocation_id=a.id AND ri.company_id=a.company_id AND r.state NOT IN ('REJECTED','CANCELLED')),0) AS remaining FROM stock_allocations a WHERE a.company_id=? AND a.shipment_id=? AND a.state='DISPATCHED'`,ctx.companyId,s.id).filter(a=>a.remaining>0);
 if(s.order_source==='STOCK'&&!allocations.length)throw fail(409,'Aucun produit sorti restant à retourner');
 const returnId=id(),ref=reference('RET'),time=now();
 ctx.run(`INSERT INTO parcel_returns(id,company_id,shipment_id,merchant_id,reference,kind,state,reason,after_delivery,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'RETURN','AUTHORIZED',?,0,?,?,?)`,returnId,ctx.companyId,s.id,s.merchant_id,ref,'Retour de non-livraison : '+s.status,ctx.user.id,time,time);
 for(const a of allocations)ctx.run('INSERT INTO return_items(id,company_id,return_id,allocation_id,product_id,quantity) VALUES(?,?,?,?,?,?)',id(),ctx.companyId,returnId,a.id,a.product_id,a.remaining);
 ctx.audit(ctx.companyId,ctx.user.id,'RETURN_REQUESTED','return',returnId,{shipmentId:s.id,source:'CITY_CONTAINER'});
 return ctx.stmt('SELECT * FROM parcel_returns WHERE id=? AND company_id=?',returnId,ctx.companyId);
}
function eligibleCityParcel(ctx,s,agencyId){
 if(s.agency_id!==agencyId||s.custody_agency_id!==agencyId||!['AGENCY','DRIVER'].includes(s.custody_type))throw fail(409,'Ce colis n’est pas physiquement dans cette ville : vérifiez son dernier scan');
 const r=ctx.stmt('SELECT * FROM parcel_returns WHERE shipment_id=? AND company_id=? AND active=1',s.id,ctx.companyId);
 if(!failureStatuses.includes(s.status)&&!(r&&!r.after_delivery&&r.kind==='RETURN'&&['REQUESTED','AUTHORIZED'].includes(r.state)))throw fail(409,'Ce colis n’est pas éligible au retour de non-livraison');
 if(r&&(r.kind!=='RETURN'||r.after_delivery||!['REQUESTED','AUTHORIZED'].includes(r.state)))throw fail(409,'Ce dossier retour suit un autre parcours');
}
function returnContainer(ctx,containerId){
 const d=ctx.stmt('SELECT c.*,a.city,a.name AS agency_name FROM return_containers c JOIN agencies a ON a.id=c.agency_id AND a.company_id=c.company_id WHERE c.id=? AND c.company_id=?',containerId,ctx.companyId);
 if(!d)throw fail(404,'Container retour introuvable');requireAgency(ctx.user,d.agency_id);return d;
}
function containerDetail(ctx,containerId){
 const container=returnContainer(ctx,containerId),items=ctx.all(`SELECT i.*,s.tracking,s.recipient,s.city,s.status,s.order_source,s.custody_type,s.custody_agency_id,m.name AS merchant_name,r.state AS return_state,r.disposition FROM return_container_items i JOIN shipments s ON s.id=i.shipment_id AND s.company_id=i.company_id LEFT JOIN parcel_returns r ON r.id=i.return_id AND r.company_id=i.company_id LEFT JOIN merchants m ON m.id=s.merchant_id AND m.company_id=s.company_id WHERE i.container_id=? AND i.company_id=? ORDER BY s.tracking`,containerId,ctx.companyId);
 return {container,items,summary:{expected:items.length,scanned:items.filter(i=>i.scanned_at).length,received:items.filter(i=>i.received_at).length,missing:items.filter(i=>!i.scanned_at).length,notReceived:items.filter(i=>!i.received_at).length}};
}
function handoff(ctx,bonId){
 const b=ctx.stmt('SELECT b.*,m.name AS merchant_name FROM merchant_return_bons b JOIN merchants m ON m.id=b.merchant_id AND m.company_id=b.company_id WHERE b.id=? AND b.company_id=?',bonId,ctx.companyId);
 if(!b)throw fail(404,'Bon de retour marchand introuvable');if(ctx.user.role==='MERCHANT'&&b.merchant_id!==ctx.user.merchant_id)throw fail(403,'Bon d’un autre marchand');return b;
}
function handoffDetail(ctx,bonId){const bon=handoff(ctx,bonId),items=ctx.all(`SELECT i.*,s.tracking,s.recipient,s.order_source,r.reference,r.condition,r.disposition FROM merchant_return_bon_items i JOIN shipments s ON s.id=i.shipment_id AND s.company_id=i.company_id JOIN parcel_returns r ON r.id=i.return_id AND r.company_id=i.company_id WHERE i.bon_id=? AND i.company_id=? ORDER BY s.tracking`,bonId,ctx.companyId);return {bon,items,summary:{expected:items.length,scanned:items.filter(i=>i.scanned_at).length,missing:items.filter(i=>!i.scanned_at).length}};}
function eligibleHandoff(ctx,s,merchantId){
 const r=ctx.stmt("SELECT * FROM parcel_returns WHERE shipment_id=? AND company_id=? AND state='INSPECTED' AND disposition='RETURN_MERCHANT' AND active=1",s.id,ctx.companyId);
 if(s.merchant_id!==merchantId||s.custody_type!=='WAREHOUSE'||!r)throw fail(409,'Colis non disponible pour remise à ce marchand');return r;
}
function printRows(items){return `<table><tr><th>Tracking</th><th>Source</th><th>Scan</th><th>Réception</th></tr>${items.map(i=>`<tr><td>${esc(i.tracking)}</td><td>${i.order_source==='STOCK'?'Stock':'Ramassage'}</td><td>${esc(i.scanned_at||'MANQUANT')}</td><td>${esc(i.received_at||'—')}</td></tr>`).join('')}</table>`;}

export async function returnNetworkRoute(ctx){
 const {path,method,user,companyId,stmt,all,run,tx,json,req,res,send,audit}=ctx;
 if(path==='/api/workflow/agency-parcels'&&method==='GET'){
  requirePermission(user,'shipments.read');const scope=shipmentScope(user,'s'),args=[companyId,...scope.args],where=`s.company_id=?${scope.clause} AND s.custody_type IN ('AGENCY','DRIVER')`;
  const cities=all(`SELECT a.id,a.city,a.name,COUNT(s.id) AS parcels,SUM(CASE WHEN s.status IN ('REFUSED','CANCELLED','UNREACHABLE','DAMAGED','RETURNING') THEN 1 ELSE 0 END) AS returns_due FROM shipments s JOIN agencies a ON a.id=s.custody_agency_id AND a.company_id=s.company_id WHERE ${where} GROUP BY a.id ORDER BY a.city`,...args);
  const shipments=all(`SELECT s.*,m.name AS merchant_name,a.name AS custody_agency_name FROM shipments s LEFT JOIN merchants m ON m.id=s.merchant_id AND m.company_id=s.company_id LEFT JOIN agencies a ON a.id=s.custody_agency_id AND a.company_id=s.company_id WHERE ${where} ORDER BY s.custody_updated_at DESC LIMIT 1000`,...args);
  return send(res,200,{cities,shipments,custodyLabels:CUSTODY_LABELS,limit:1000,total:cities.reduce((n,c)=>n+c.parcels,0)});
 }
 if(path==='/api/workflow/return-containers'){
  requirePermission(user,'returns.manage','returns.receive');
  if(method==='GET'){
   const scope=agencyScoped(user)?' AND s.agency_id=?':'',args=[companyId,...agencyScoped(user)?[user.agency_id||'NO_AGENCY']:[]];
   const where=`s.company_id=?${scope} AND s.custody_type IN ('AGENCY','DRIVER','RETURN_TRANSIT','OUTBOUND') AND (s.status IN ('REFUSED','CANCELLED','UNREACHABLE','DAMAGED','RETURNING') OR EXISTS(SELECT 1 FROM parcel_returns r WHERE r.shipment_id=s.id AND r.company_id=s.company_id AND r.active=1 AND r.kind='RETURN' AND r.after_delivery=0 AND r.state IN ('REQUESTED','AUTHORIZED','IN_TRANSIT')))`;
   const cities=all(`SELECT a.id,a.city,a.name,COUNT(*) AS outstanding,SUM(CASE WHEN s.custody_type IN ('AGENCY','DRIVER') AND NOT EXISTS(SELECT 1 FROM return_container_items i WHERE i.shipment_id=s.id AND i.company_id=s.company_id AND i.active=1) THEN 1 ELSE 0 END) AS to_pack,SUM(CASE WHEN s.custody_type='RETURN_TRANSIT' THEN 1 ELSE 0 END) AS in_transit FROM shipments s JOIN agencies a ON a.id=s.agency_id AND a.company_id=s.company_id WHERE ${where} GROUP BY a.id ORDER BY a.city`,...args);
   const outstanding=all(`SELECT s.*,m.name AS merchant_name,(SELECT container_id FROM return_container_items i WHERE i.shipment_id=s.id AND i.company_id=s.company_id AND i.active=1) AS return_container_id FROM shipments s LEFT JOIN merchants m ON m.id=s.merchant_id AND m.company_id=s.company_id WHERE ${where} ORDER BY s.custody_updated_at LIMIT 1000`,...args);
   const containers=all(`SELECT c.*,a.city,a.name AS agency_name,COUNT(i.shipment_id) AS expected,COUNT(i.scanned_at) AS scanned,COUNT(i.received_at) AS received FROM return_containers c JOIN agencies a ON a.id=c.agency_id AND a.company_id=c.company_id LEFT JOIN return_container_items i ON i.container_id=c.id AND i.company_id=c.company_id WHERE c.company_id=?${agencyScoped(user)?' AND c.agency_id=?':''} GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`,...args);
   return send(res,200,{cities,outstanding,containers,custodyLabels:CUSTODY_LABELS,limit:1000,total:cities.reduce((n,c)=>n+c.outstanding,0)});
  }
  if(method==='POST'){
   packing(ctx);const data=await json(req);validateIds(data.shipmentIds);
   const agency=stmt('SELECT * FROM agencies WHERE id=? AND company_id=?',data.agencyId,companyId);if(!agency)throw fail(400,'Agence de départ requise');requireAgency(user,agency.id);
   const containerId=id();tx(()=>{
    run("INSERT INTO return_containers(id,company_id,agency_id,reference,state,created_by,created_at) VALUES(?,?,?,?,'OPEN',?,?)",containerId,companyId,agency.id,reference('RVC'),user.id,now());
    for(const sid of data.shipmentIds||[]){const s=stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',sid,companyId);if(!s)throw fail(404,'Colis introuvable');eligibleCityParcel(ctx,s,agency.id);if(stmt('SELECT 1 FROM return_container_items WHERE company_id=? AND shipment_id=? AND active=1',companyId,s.id))throw fail(409,'Colis dans un autre container retour');run('INSERT INTO return_container_items(company_id,container_id,shipment_id) VALUES(?,?,?)',companyId,containerId,s.id);}
    audit(companyId,user.id,'RETURN_CONTAINER_CREATED','return_container',containerId,{agencyId:agency.id,expected:data.shipmentIds?.length||0});
   });return send(res,201,containerDetail(ctx,containerId));
  }
 }
 const match=path.match(/^\/api\/workflow\/return-containers\/([a-f0-9-]{36})(?:\/(scan|close|ship|receive-scan|cancel|print))?$/);
 if(match){
  requirePermission(user,'returns.manage','returns.receive');const containerId=match[1],action=match[2],d=returnContainer(ctx,containerId);
  if(method==='GET'&&!action)return send(res,200,containerDetail(ctx,containerId));
  if(method==='GET'&&action==='print'){const x=containerDetail(ctx,containerId);return html(res,documentHtml('Retour ville '+d.reference,`<p>${esc(d.agency_name)} · ${esc(d.city)} → Agence d’origine</p><p>${esc(d.state)} · Preuve : ${esc(d.proof_reference||'—')}</p>${printRows(x.items)}<p>${x.summary.received} / ${x.summary.expected} reçus. Les colis non reçus restent signalés comme manquants.</p>`));}
  if(method!=='POST')throw fail(405,'Méthode non autorisée');const data=await json(req);
  if(action==='receive-scan')central(ctx);else packing(ctx);
  const result=tx(()=>{
   const current=returnContainer(ctx,containerId);
   if(action==='scan'){
    if(current.state!=='OPEN')throw fail(409,'Container retour fermé');const s=scanShipment(ctx,data.scan),existing=stmt('SELECT * FROM return_container_items WHERE company_id=? AND shipment_id=? AND active=1',companyId,s.id);
    if(existing&&existing.container_id!==containerId)throw fail(409,'Colis dans un autre container retour');
    if(existing?.scanned_at)return {...containerDetail(ctx,containerId),duplicate:true,acceptedTracking:s.tracking};
    eligibleCityParcel(ctx,s,current.agency_id);const r=returnRecord(ctx,s),time=now();
    if(!existing)run('INSERT INTO return_container_items(company_id,container_id,shipment_id) VALUES(?,?,?)',companyId,containerId,s.id);
    run('UPDATE return_container_items SET return_id=?,status_before_scan=?,scanned_at=?,scanned_by=? WHERE container_id=? AND shipment_id=? AND company_id=?',r.id,s.status,time,user.id,containerId,s.id,companyId);
    run("UPDATE delivery_route_items SET state='CANCELLED',active=0 WHERE shipment_id=? AND company_id=? AND active=1",s.id,companyId);
    parcelEvent(ctx,s,'RETURNING','Scanné dans le retour ville '+current.reference,'RETURN');setCustody(ctx,s,'AGENCY',{agencyId:current.agency_id,scan:true});
    audit(companyId,user.id,'RETURN_CONTAINER_SCANNED','return_container',containerId,{shipmentId:s.id});return {...containerDetail(ctx,containerId),acceptedTracking:s.tracking};
   }
   if(action==='close'||action==='ship'){
    if(current.state!==(action==='close'?'OPEN':'CLOSED'))throw fail(409,'État du container incompatible');const x=containerDetail(ctx,containerId);
    if(!x.items.length||x.summary.missing)throw fail(409,'Container vide ou colis attendus non scannés');
    for(const i of x.items){if(i.status!=='RETURNING'||i.custody_type!=='AGENCY'||i.custody_agency_id!==current.agency_id||i.return_state!=='AUTHORIZED')throw fail(409,'Contenu du container modifié : recontrôlez les colis');}
    if(action==='close')run("UPDATE return_containers SET state='CLOSED',closed_at=? WHERE id=? AND company_id=?",now(),containerId,companyId);
    else{
     const proof=clean(data.proofReference,120);if(proof.length<3)throw fail(400,'Référence de transport / scellé requise');
     run("UPDATE return_containers SET state='SHIPPED',proof_reference=?,shipped_at=? WHERE id=? AND company_id=?",proof,now(),containerId,companyId);
     for(const i of x.items){run("UPDATE parcel_returns SET state='IN_TRANSIT',proof_reference=?,updated_at=? WHERE id=? AND company_id=?",proof,now(),i.return_id,companyId);setCustody(ctx,{id:i.shipment_id},'RETURN_TRANSIT',{agencyId:current.agency_id});notify(ctx,{merchant:stmt('SELECT merchant_id FROM shipments WHERE id=? AND company_id=?',i.shipment_id,companyId).merchant_id},'Retour ville expédié '+i.tracking,'return',i.return_id);}
    }
    audit(companyId,user.id,action==='close'?'RETURN_CONTAINER_CLOSED':'RETURN_CONTAINER_SHIPPED','return_container',containerId,{count:x.items.length});
   }else if(action==='receive-scan'){
    if(!['SHIPPED','RECEIVED'].includes(current.state))throw fail(409,'Container retour non expédié');const s=scanShipment(ctx,data.scan),i=stmt('SELECT * FROM return_container_items WHERE container_id=? AND company_id=? AND shipment_id=?',containerId,companyId,s.id);
    if(!i||!i.scanned_at)throw fail(409,'Colis non attendu dans ce container retour');if(i.received_at)return {...containerDetail(ctx,containerId),duplicate:true,acceptedTracking:s.tracking};
    if(s.custody_type!=='RETURN_TRANSIT')throw fail(409,'Localisation du colis incohérente avec ce retour');
    const r=stmt('SELECT * FROM parcel_returns WHERE id=? AND company_id=?',i.return_id,companyId),condition=data.condition;
    receiveReturn(ctx,r,s,{scan:data.scan,condition,note:data.note});
    if(['GOOD','SEALED'].includes(condition)){
     const received=stmt('SELECT * FROM parcel_returns WHERE id=? AND company_id=?',r.id,companyId);
     inspectReturn(ctx,received,s,{disposition:s.order_source==='STOCK'?'RESTOCK':'RETURN_MERCHANT',note:'Contrôle de conformité confirmé au scan du container '+current.reference,location:data.location});
     if(s.order_source==='STOCK')completeReturn(ctx,stmt('SELECT * FROM parcel_returns WHERE id=? AND company_id=?',r.id,companyId),s,{});
    }
    run('UPDATE return_container_items SET received_at=?,received_by=?,condition=?,active=0 WHERE container_id=? AND shipment_id=? AND company_id=?',now(),user.id,condition,containerId,s.id,companyId);
    if(!stmt('SELECT 1 FROM return_container_items WHERE container_id=? AND company_id=? AND received_at IS NULL',containerId,companyId))run("UPDATE return_containers SET state='RECEIVED',received_at=? WHERE id=? AND company_id=?",now(),containerId,companyId);
    audit(companyId,user.id,'RETURN_CONTAINER_RECEIVED','return_container',containerId,{shipmentId:s.id,condition,restocked:s.order_source==='STOCK'&&['GOOD','SEALED'].includes(condition)});return {...containerDetail(ctx,containerId),acceptedTracking:s.tracking};
   }else if(action==='cancel'){
    if(!['OPEN','CLOSED'].includes(current.state)||clean(data.reason).length<5)throw fail(409,'Seul un container non expédié peut être annulé avec motif');
    for(const i of containerDetail(ctx,containerId).items){if(i.scanned_at&&i.status==='RETURNING'&&i.custody_type==='AGENCY')parcelEvent(ctx,{id:i.shipment_id},i.status_before_scan,'Container retour annulé : '+clean(data.reason,200),'RETURN');}
    run('UPDATE return_container_items SET active=0 WHERE container_id=? AND company_id=?',containerId,companyId);run("UPDATE return_containers SET state='CANCELLED' WHERE id=? AND company_id=?",containerId,companyId);audit(companyId,user.id,'RETURN_CONTAINER_CANCELLED','return_container',containerId,{reason:clean(data.reason,200)});
   }else throw fail(404,'Action retour ville inconnue');
   return containerDetail(ctx,containerId);
  });return send(res,200,result);
 }
 if(path==='/api/workflow/merchant-returns'){
  if(user.role!=='MERCHANT')central(ctx);
  if(method==='GET'){
   const own=user.role==='MERCHANT',args=[companyId,...own?[user.merchant_id]:[]];
   const items=all(`SELECT r.id AS return_id,r.reference,r.condition,r.disposition,r.state,s.id AS shipment_id,s.tracking,s.city,s.order_source,s.merchant_id,s.custody_type,m.name AS merchant_name,(SELECT i.bon_id FROM merchant_return_bon_items i WHERE i.return_id=r.id AND i.company_id=r.company_id AND i.active=1) AS bon_id FROM parcel_returns r JOIN shipments s ON s.id=r.shipment_id AND s.company_id=r.company_id JOIN merchants m ON m.id=r.merchant_id AND m.company_id=r.company_id WHERE r.company_id=?${own?' AND r.merchant_id=?':''} AND r.active=1 AND r.state IN ('RECEIVED','INSPECTED') AND s.custody_type='WAREHOUSE' ORDER BY m.name,r.received_at LIMIT 1000`,...args);
   const bons=all(`SELECT b.*,m.name AS merchant_name,COUNT(i.return_id) AS expected,COUNT(i.scanned_at) AS scanned FROM merchant_return_bons b JOIN merchants m ON m.id=b.merchant_id AND m.company_id=b.company_id LEFT JOIN merchant_return_bon_items i ON i.bon_id=b.id AND i.company_id=b.company_id WHERE b.company_id=?${own?' AND b.merchant_id=?':''} GROUP BY b.id ORDER BY b.created_at DESC LIMIT 200`,...args);
   return send(res,200,{items,bons,limit:1000});
  }
  if(method==='POST'){
   central(ctx);const data=await json(req);validateIds(data.shipmentIds);if(!stmt('SELECT 1 FROM merchants WHERE id=? AND company_id=?',data.merchantId,companyId))throw fail(404,'Marchand introuvable');
   const bonId=id();tx(()=>{run("INSERT INTO merchant_return_bons(id,company_id,merchant_id,reference,state,created_by,created_at) VALUES(?,?,?,?,'OPEN',?,?)",bonId,companyId,data.merchantId,reference('RMC'),user.id,now());for(const sid of data.shipmentIds||[]){const s=stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',sid,companyId);if(!s)throw fail(404,'Colis introuvable');const r=eligibleHandoff(ctx,s,data.merchantId);if(stmt('SELECT 1 FROM merchant_return_bon_items WHERE return_id=? AND company_id=? AND active=1',r.id,companyId))throw fail(409,'Retour déjà dans un bon marchand');run('INSERT INTO merchant_return_bon_items(company_id,bon_id,return_id,shipment_id) VALUES(?,?,?,?)',companyId,bonId,r.id,s.id);}audit(companyId,user.id,'MERCHANT_RETURN_BON_CREATED','merchant_return_bon',bonId,{merchantId:data.merchantId});});return send(res,201,handoffDetail(ctx,bonId));
  }
 }
 const handoffMatch=path.match(/^\/api\/workflow\/merchant-returns\/([a-f0-9-]{36})(?:\/(scan|complete|cancel|print))?$/);
 if(handoffMatch){
  if(user.role!=='MERCHANT')central(ctx);const bonId=handoffMatch[1],action=handoffMatch[2],b=handoff(ctx,bonId);
  if(method==='GET'&&!action)return send(res,200,handoffDetail(ctx,bonId));
  if(method==='GET'&&action==='print'){const x=handoffDetail(ctx,bonId);return html(res,documentHtml('Remise retours '+b.reference,`<p>Marchand : ${esc(b.merchant_name)}</p><p>État : ${esc(b.state)} · Réceptionnaire : ${esc(b.receiver_name||'—')} · Preuve : ${esc(b.proof_reference||'—')}</p>${printRows(x.items)}`));}
  central(ctx);if(method!=='POST')throw fail(405,'Méthode non autorisée');const data=await json(req);
  const result=tx(()=>{
   const current=handoff(ctx,bonId);if(current.state!=='OPEN')throw fail(409,'Bon marchand déjà clôturé');
   if(action==='scan'){
    const s=scanShipment(ctx,data.scan),r=eligibleHandoff(ctx,s,current.merchant_id),existing=stmt('SELECT * FROM merchant_return_bon_items WHERE return_id=? AND company_id=? AND active=1',r.id,companyId);
    if(existing&&existing.bon_id!==bonId)throw fail(409,'Retour dans un autre bon marchand');if(existing?.scanned_at)return {...handoffDetail(ctx,bonId),duplicate:true,acceptedTracking:s.tracking};
    if(!existing)run('INSERT INTO merchant_return_bon_items(company_id,bon_id,return_id,shipment_id) VALUES(?,?,?,?)',companyId,bonId,r.id,s.id);
    run('UPDATE merchant_return_bon_items SET scanned_at=?,scanned_by=? WHERE bon_id=? AND return_id=? AND company_id=?',now(),user.id,bonId,r.id,companyId);setCustody(ctx,s,'WAREHOUSE',{scan:true});audit(companyId,user.id,'MERCHANT_RETURN_SCANNED','merchant_return_bon',bonId,{shipmentId:s.id});return {...handoffDetail(ctx,bonId),acceptedTracking:s.tracking};
   }
   if(action==='complete'){
    const x=handoffDetail(ctx,bonId),receiverName=clean(data.receiverName,120),proofReference=clean(data.proofReference,120);if(!x.items.length||x.summary.missing)throw fail(409,'Bon vide ou retours attendus non scannés');if(!receiverName||proofReference.length<3)throw fail(400,'Nom du réceptionnaire et preuve de remise requis');
    for(const i of x.items){const s=stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',i.shipment_id,companyId),r=eligibleHandoff(ctx,s,current.merchant_id);completeReturn(ctx,r,s,{receiverName,proofReference});setCustody(ctx,s,'MERCHANT');if(!r.after_delivery)parcelEvent(ctx,s,'RETURNED_MERCHANT','Remis au marchand — '+current.reference,'RETURN');}
    run("UPDATE merchant_return_bons SET state='COMPLETED',receiver_name=?,proof_reference=?,completed_at=? WHERE id=? AND company_id=?",receiverName,proofReference,now(),bonId,companyId);run('UPDATE merchant_return_bon_items SET active=0 WHERE bon_id=? AND company_id=?',bonId,companyId);audit(companyId,user.id,'MERCHANT_RETURN_BON_COMPLETED','merchant_return_bon',bonId,{receiverName,proofReference,count:x.items.length});
   }else if(action==='cancel'){if(clean(data.reason).length<5)throw fail(400,'Motif requis');run("UPDATE merchant_return_bons SET state='CANCELLED' WHERE id=? AND company_id=?",bonId,companyId);run('UPDATE merchant_return_bon_items SET active=0 WHERE bon_id=? AND company_id=?',bonId,companyId);audit(companyId,user.id,'MERCHANT_RETURN_BON_CANCELLED','merchant_return_bon',bonId,{reason:clean(data.reason,200)});}
   else throw fail(404,'Action remise marchand inconnue');return handoffDetail(ctx,bonId);
  });return send(res,200,result);
 }
 throw fail(404,'Route réseau retours introuvable');
}
