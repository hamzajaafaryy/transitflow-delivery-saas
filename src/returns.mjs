import {setCustody} from './custody.mjs';
import {stockMovement} from './stock-ledger.mjs';
import {id,now} from './db.mjs';
import {has,requirePermission,agencyScoped,requireAgency} from './access.mjs';
import {clean,fail,reference,shipment,returnAccess,scanShipment,parcelEvent,notify,documentHtml,html,esc,integer} from './workflow-shared.mjs';

function returnsDetail(ctx,r){return {containerId:ctx.stmt('SELECT container_id FROM return_container_items WHERE return_id=? AND company_id=? AND active=1',r.id,ctx.companyId)?.container_id||null,merchantBonId:ctx.stmt('SELECT bon_id FROM merchant_return_bon_items WHERE return_id=? AND company_id=? AND active=1',r.id,ctx.companyId)?.bon_id||null,return:r,shipment:ctx.stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',r.shipment_id,ctx.companyId),items:ctx.all('SELECT ri.*,p.sku,p.name FROM return_items ri JOIN inventory_products p ON p.id=ri.product_id AND p.company_id=ri.company_id WHERE ri.return_id=? AND ri.company_id=?',r.id,ctx.companyId),adjustments:['ADMIN','FINANCE','MERCHANT'].includes(ctx.user.role)?ctx.all('SELECT amount_centimes,kind,reference,note FROM merchant_adjustments WHERE return_id=? AND company_id=?',r.id,ctx.companyId):[]};}
export function receiveReturn(ctx,r,s,data){
 const {user,companyId,stmt,all,run,audit}=ctx,returnId=r.id;
  requirePermission(user,'returns.receive');if(r.state!=='IN_TRANSIT')throw fail(409,'Retour non expédié');const scanned=scanShipment(ctx,data.scan),condition=data.condition;if(scanned.id!==s.id)throw fail(409,'Ce scan ne correspond pas au colis retourné');if(!['SEALED','GOOD','DAMAGED','INCOMPLETE'].includes(condition))throw fail(400,'État physique requis');if(['DAMAGED','INCOMPLETE'].includes(condition)&&clean(data.note).length<5)throw fail(400,'Détail de l’écart physique requis');
  {run("UPDATE parcel_returns SET state='RECEIVED',condition=?,inspection_note=?,received_at=?,updated_at=? WHERE id=? AND company_id=?",condition,clean(data.note,400),now(),now(),returnId,companyId);if(!r.after_delivery)parcelEvent(ctx,s,'RETURNED','Retour réceptionné — en attente de contrôle '+r.reference,'RETURN');setCustody(ctx,s,'WAREHOUSE',{scan:true});audit(companyId,user.id,'RETURN_RECEIVED','return',returnId,{condition});notify(ctx,{merchant:r.merchant_id},'Retour reçu, en contrôle '+r.reference,'return',returnId);}
}
export function inspectReturn(ctx,r,s,data){
 const {user,companyId,stmt,all,run,audit}=ctx,returnId=r.id;
  requirePermission(user,'returns.receive');if(r.state!=='RECEIVED')throw fail(409,'Réception physique requise avant contrôle');const disposition=data.disposition,note=clean(data.note,400),location=clean(data.location,100)||'ENTREPOT / RETOURS VALIDÉS';
  if(!['RESTOCK','RETURN_MERCHANT','RESHIP','DISCARD'].includes(disposition)||note.length<5)throw fail(400,'Décision et note de contrôle requises');
  if(['RESTOCK','RESHIP'].includes(disposition)&&!['SEALED','GOOD'].includes(r.condition))throw fail(409,'Colis endommagé ou incomplet : aucune remise en stock ou réexpédition automatique');if(disposition==='RESTOCK'&&s.order_source!=='STOCK')throw fail(409,'Un colis externe ne peut pas créer un stock SKU');
  {
   if(s.order_source==='STOCK'&&['RESTOCK','RESHIP'].includes(disposition)){
    const lines=all('SELECT * FROM return_items WHERE return_id=? AND company_id=?',returnId,companyId);
    for(const line of lines){if(line.restocked_lot_id)throw fail(409,'Produit déjà remis en stock');const p=stmt('SELECT merchant_id FROM inventory_products WHERE id=? AND company_id=?',line.product_id,companyId);if(!p||p.merchant_id!==s.merchant_id)throw fail(409,'Propriété du produit modifiée ; contrôle manuel requis');const lotId=id();run('INSERT INTO stock_lots(id,company_id,product_id,received_at,quantity_on_hand,location) VALUES(?,?,?,?,?,?)',lotId,companyId,line.product_id,now(),line.quantity,location);run('UPDATE return_items SET restocked_lot_id=? WHERE id=? AND company_id=?',lotId,line.id,companyId);stockMovement(ctx,{productId:line.product_id,lotId,kind:'RETURN',physical:line.quantity,entityType:'return',entityId:returnId,eventKey:'RETURN:'+line.id});}
   }
   run("UPDATE parcel_returns SET state='INSPECTED',disposition=?,inspection_note=?,updated_at=? WHERE id=? AND company_id=?",disposition,note,now(),returnId,companyId);audit(companyId,user.id,'RETURN_INSPECTED','return',returnId,{disposition,note});notify(ctx,{merchant:r.merchant_id},'Retour contrôlé : '+disposition,'return',returnId);
  }
}
export function completeReturn(ctx,r,s,data){
 const {user,companyId,stmt,all,run,audit}=ctx,returnId=r.id;
  requirePermission(user,'returns.receive');if(r.state!=='INSPECTED'||r.disposition==='RESHIP')throw fail(409,'Contrôle requis ; une réexpédition doit créer un nouveau tracking');if(r.disposition==='RETURN_MERCHANT'&&(!clean(data.receiverName)||clean(data.proofReference).length<3))throw fail(400,'Nom du marchand réceptionnaire et preuve de remise requis');
  {run("UPDATE parcel_returns SET state='COMPLETED',active=0,proof_reference=COALESCE(NULLIF(?,''),proof_reference),completed_at=?,updated_at=? WHERE id=? AND company_id=?",clean(data.proofReference,120),now(),now(),returnId,companyId);if(r.disposition==='RETURN_MERCHANT')setCustody(ctx,s,'MERCHANT');audit(companyId,user.id,'RETURN_COMPLETED','return',returnId,{receiverName:clean(data.receiverName),disposition:r.disposition});notify(ctx,{merchant:r.merchant_id},'Retour clôturé '+r.reference,'return',returnId);}
}
export async function returnRoute(ctx){
 const {path,method,user,companyId,stmt,all,run,tx,json,send,res,audit,createShipment}=ctx;
 requirePermission(user,'returns.create','returns.manage','returns.receive','returns.read','routes.self','pickups.self');
 if(path==='/api/workflow/returns'){
  requirePermission(user,'returns.create','returns.manage','returns.receive','returns.read','routes.self','pickups.self');
  if(method==='GET'){
   const where=['r.company_id=?'],args=[companyId];if(user.role==='MERCHANT'){where.push('r.merchant_id=?');args.push(user.merchant_id);}if(['DRIVER','PICKUP_DRIVER'].includes(user.role)){where.push('r.driver_id=?');args.push(user.id);}if(agencyScoped(user)){where.push('s.agency_id=?');args.push(user.agency_id||'NO_AGENCY');}
   return send(res,200,{returns:all(`SELECT r.*,s.tracking,s.city,s.order_source,m.name AS merchant_name,u.full_name AS driver_name FROM parcel_returns r JOIN shipments s ON s.id=r.shipment_id AND s.company_id=r.company_id LEFT JOIN merchants m ON m.id=r.merchant_id LEFT JOIN users u ON u.id=r.driver_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 300`,...args)});
  }
  if(method==='POST'){
   requirePermission(user,'returns.create','returns.manage','returns.receive');const data=await json(ctx.req),s=shipment(ctx,data.shipmentId),reason=clean(data.reason,400),kind=data.kind||'RETURN';
   if(reason.length<5||!['RETURN','EXCHANGE'].includes(kind))throw fail(400,'Motif et type de retour requis');
   if(!['COLLECTED','PICKED_UP','AT_AGENCY','IN_TRANSIT','OUT_FOR_DELIVERY','POSTPONED','UNREACHABLE','REFUSED','DELIVERED','RETURNING','DAMAGED','CANCELLED'].includes(s.status))throw fail(409,'Colis non éligible : une commande non collectée doit être annulée');
   if(s.status==='CANCELLED'&&!s.ramassed_at&&!s.collected_at)throw fail(409,'Commande annulée avant collecte : aucun colis physique à retourner');
   const returnId=id(),ref=reference('RET');
   tx(()=>{
    if(stmt('SELECT 1 FROM parcel_returns WHERE shipment_id=? AND company_id=? AND active=1',s.id,companyId))throw fail(409,'Un retour est déjà ouvert pour ce colis');
    const allocations=all(`SELECT a.*,COALESCE((SELECT SUM(ri.quantity) FROM return_items ri JOIN parcel_returns pr ON pr.id=ri.return_id WHERE ri.allocation_id=a.id AND ri.company_id=a.company_id AND pr.state NOT IN ('REJECTED','CANCELLED')),0) AS already_returned FROM stock_allocations a WHERE a.shipment_id=? AND a.company_id=? AND a.state='DISPATCHED'`,s.id,companyId);
    let lines=allocations.map(a=>({allocationId:a.id,productId:a.product_id,quantity:a.quantity-a.already_returned})).filter(a=>a.quantity>0);
    if(data.items!==undefined){if(!Array.isArray(data.items)||!data.items.length||new Set(data.items.map(i=>i.allocationId)).size!==data.items.length)throw fail(400,'Lignes de retour invalides');lines=data.items.map(i=>{const a=allocations.find(x=>x.id===i.allocationId);const quantity=integer(i.quantity);if(!a||quantity>a.quantity-a.already_returned)throw fail(409,'Quantité de retour supérieure aux produits réellement sortis');return {allocationId:a.id,productId:a.product_id,quantity};});}
    if(s.order_source==='STOCK'&&!lines.length)throw fail(409,'Aucun produit sorti éligible au retour');if(s.order_source==='EXTERNAL'&&data.items?.length)throw fail(400,'Un colis externe ne possède pas de lignes stock');
    run(`INSERT INTO parcel_returns(id,company_id,shipment_id,merchant_id,reference,kind,state,reason,after_delivery,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'REQUESTED',?,?,?,?,?)`,returnId,companyId,s.id,s.merchant_id,ref,kind,reason,s.status==='DELIVERED'?1:0,user.id,now(),now());
    for(const line of lines)run('INSERT INTO return_items(id,company_id,return_id,allocation_id,product_id,quantity) VALUES(?,?,?,?,?,?)',id(),companyId,returnId,line.allocationId,line.productId,line.quantity);
    audit(companyId,user.id,'RETURN_REQUESTED','return',returnId,{shipmentId:s.id,kind});notify(ctx,{roles:['ADMIN','OPERATIONS','SUPPORT']},'Retour à traiter '+ref,'return',returnId);
   });return send(res,201,{id:returnId,reference:ref,state:'REQUESTED'});
  }
 }
 const match=path.match(/^\/api\/workflow\/returns\/([a-f0-9-]{36})(?:\/(authorize|assign|ship|receive|inspect|complete|cancel|reexpedite|replacement|print))?$/);if(!match)return false;
 const returnId=match[1],action=match[2],r=returnAccess(ctx,stmt('SELECT * FROM parcel_returns WHERE id=? AND company_id=?',returnId,companyId)),s=stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',r.shipment_id,companyId);
 if(method==='GET'&&!action)return send(res,200,returnsDetail(ctx,r));
 if(method==='GET'&&action==='print'){const d=returnsDetail(ctx,r);return html(res,documentHtml('Bon de retour '+r.reference,`<p>Tracking ${esc(s.tracking)} · ${esc(r.kind)} · ${esc(r.state)}</p><p>Motif : ${esc(r.reason)}</p><p>Destination d’origine : ${esc(s.city)} · Origine ${esc(s.order_source)}</p><table><tr><th>SKU</th><th>Article</th><th>Quantité attendue</th></tr>${d.items.map(i=>`<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td>${i.quantity}</td></tr>`).join('')}</table><p>La réception et l’inspection sont nécessaires avant toute remise en stock. Aucun remboursement bancaire n’est déclenché par ce document.</p>`));}
 if(method!=='POST')throw fail(405,'Méthode non autorisée');const data=await json(ctx.req);
 if(action==='authorize'){
  requirePermission(user,'returns.manage');if(r.state!=='REQUESTED')throw fail(409,'Retour déjà traité');const accepted=data.accepted!==false,note=clean(data.note,400);if(note.length<5)throw fail(400,'Décision motivée requise');
  tx(()=>{run('UPDATE parcel_returns SET state=?,active=?,inspection_note=?,updated_at=? WHERE id=? AND company_id=?',accepted?'AUTHORIZED':'REJECTED',accepted?1:0,note,now(),returnId,companyId);
   if(accepted){run("UPDATE delivery_route_items SET state='CANCELLED',active=0 WHERE shipment_id=? AND company_id=? AND active=1",s.id,companyId);}
   audit(companyId,user.id,'RETURN_DECISION','return',returnId,{accepted,note});notify(ctx,{merchant:r.merchant_id},accepted?'Retour autorisé '+r.reference:'Retour refusé '+r.reference,'return',returnId);
  });
 }else if(action==='assign'){
  requirePermission(user,'returns.manage');if(!['AUTHORIZED','IN_TRANSIT'].includes(r.state))throw fail(409,'Retour non autorisé');const driver=stmt("SELECT * FROM users WHERE id=? AND company_id=? AND role IN ('DRIVER','PICKUP_DRIVER') AND active=1",data.driverId,companyId);if(!driver)throw fail(400,'Conducteur invalide');if(agencyScoped(user)&&driver.agency_id&&driver.agency_id!==user.agency_id)throw fail(403,'Conducteur d’une autre agence');
  tx(()=>{run('UPDATE parcel_returns SET driver_id=?,updated_at=? WHERE id=? AND company_id=?',driver.id,now(),returnId,companyId);notify(ctx,{users:[driver.id]},'Retour à récupérer '+r.reference,'return',returnId);audit(companyId,user.id,'RETURN_DRIVER_ASSIGNED','return',returnId,{driverId:driver.id});});
 }else if(action==='ship'){
  if(stmt('SELECT 1 FROM return_container_items WHERE return_id=? AND company_id=? AND active=1',r.id,companyId))throw fail(409,'Confirmez le départ depuis le container retour de ce colis');
  if(!['DRIVER','PICKUP_DRIVER'].includes(user.role))requirePermission(user,'returns.manage','returns.receive');if(r.state!=='AUTHORIZED')throw fail(409,'Retour non autorisé');if(clean(data.proofReference,120).length<3)throw fail(400,'Référence de remise retour requise');
  tx(()=>{run("UPDATE parcel_returns SET state='IN_TRANSIT',proof_reference=?,updated_at=? WHERE id=? AND company_id=?",clean(data.proofReference,120),now(),returnId,companyId);setCustody(ctx,s,'RETURN_TRANSIT',{agencyId:s.custody_agency_id});if(!r.after_delivery)parcelEvent(ctx,s,'RETURNING','Retour en cours — '+r.reference,'RETURN');audit(companyId,user.id,'RETURN_DISPATCHED','return',returnId);});
 }else if(action==='receive'){
  if(stmt('SELECT 1 FROM return_container_items WHERE return_id=? AND company_id=? AND active=1',r.id,companyId))throw fail(409,'Réceptionnez ce colis depuis son container retour');
  tx(()=>receiveReturn(ctx,r,s,data));
 }else if(action==='inspect'){
  tx(()=>inspectReturn(ctx,r,s,data));
 }else if(action==='complete'){
  if(stmt('SELECT 1 FROM merchant_return_bon_items WHERE return_id=? AND company_id=? AND active=1',r.id,companyId))throw fail(409,'Confirmez la remise depuis le bon retour marchand de ce colis');
  tx(()=>completeReturn(ctx,r,s,data));
 }else if(action==='cancel'){
  if(user.role!=='MERCHANT')requirePermission(user,'returns.manage');if(r.state!=='REQUESTED'||clean(data.reason).length<5)throw fail(409,'Seule une demande non traitée peut être annulée avec motif');tx(()=>{run("UPDATE parcel_returns SET state='CANCELLED',active=0,inspection_note=?,updated_at=? WHERE id=? AND company_id=?",clean(data.reason),now(),returnId,companyId);audit(companyId,user.id,'RETURN_CANCELLED','return',returnId);});
 }else if(['reexpedite','replacement'].includes(action)){
  if(user.role!=='MERCHANT')requirePermission(user,'returns.manage','returns.receive');if(r.state!=='INSPECTED'||r.child_shipment_id||!['GOOD','SEALED'].includes(r.condition))throw fail(409,'Retour contrôlé et complet requis ; une seule nouvelle expédition est autorisée');
  const exchange=action==='replacement';if(exchange&&r.kind!=='EXCHANGE')throw fail(409,'Ce retour ne correspond pas à un échange');if(!exchange&&r.disposition!=='RESHIP')throw fail(409,'Décision de réexpédition requise');
  const next=data.order;if(!next||typeof next!=='object'||Array.isArray(next))throw fail(400,'Informations de la nouvelle commande requises');
  const child=tx(()=>{
   const payload={...next,merchantId:r.merchant_id};
   if(!exchange){payload.source=s.order_source;payload.items=s.order_source==='STOCK'?all('SELECT product_id AS productId,SUM(quantity) AS quantity FROM return_items WHERE return_id=? AND company_id=? AND restocked_lot_id IS NOT NULL GROUP BY product_id',returnId,companyId):[];}
   const created=createShipment(user,payload);if(!exchange&&s.order_source==='EXTERNAL')setCustody(ctx,created,'WAREHOUSE');run('UPDATE shipments SET replacement_of=?,reused_return_id=? WHERE id=? AND company_id=?',s.id,!exchange&&s.order_source==='EXTERNAL'?returnId:null,created.id,companyId);run("UPDATE parcel_returns SET child_shipment_id=?,state='COMPLETED',active=0,completed_at=?,updated_at=? WHERE id=? AND company_id=?",created.id,now(),now(),returnId,companyId);audit(companyId,user.id,exchange?'EXCHANGE_CREATED':'RETURN_REEXPEDITED','return',returnId,{childShipmentId:created.id});notify(ctx,{merchant:r.merchant_id},'Nouveau tracking '+created.tracking,'return',returnId);return created;
  });return send(res,201,{...returnsDetail(ctx,stmt('SELECT * FROM parcel_returns WHERE id=? AND company_id=?',returnId,companyId)),child});
 }else throw fail(404,'Action retour inconnue');
 return send(res,200,returnsDetail(ctx,stmt('SELECT * FROM parcel_returns WHERE id=? AND company_id=?',returnId,companyId)));
}
