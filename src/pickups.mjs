import {id,now} from './db.mjs';
import {requirePermission,has} from './access.mjs';
import {clean,fail,reference,isoDate,merchantId,pickupAccess,scanShipment,parcelEvent,notify,documentHtml,html,esc} from './workflow-shared.mjs';
export async function pickupRoute(ctx){
 const {path,method,url,user,companyId,stmt,all,run,tx,json,send,res,audit}=ctx;
 if(path==='/api/workflow/pickup-points'){
  requirePermission(user,'pickups.create','pickups.manage','pickups.read','warehouse');
  if(method==='GET'){const mid=user.role==='MERCHANT'?user.merchant_id:url.searchParams.get('merchantId');return send(res,200,{points:all('SELECT * FROM pickup_points WHERE company_id=?'+(mid?' AND merchant_id=?':'')+' AND active=1 ORDER BY label',...mid?[companyId,mid]:[companyId])});}
  if(method==='POST'){
   requirePermission(user,'pickups.create','pickups.manage');const data=await json(ctx.req),mid=merchantId(ctx,data.merchantId),label=clean(data.label,100),contact=clean(data.contactName,100),phone=clean(data.phone,35),city=clean(data.city,90),address=clean(data.address,400);
   if(!label||!contact||!phone||!city||!address)throw fail(400,'Point de ramassage : libellé, contact, téléphone, ville et adresse requis');
   const pointId=id();tx(()=>{run('INSERT INTO pickup_points(id,company_id,merchant_id,label,contact_name,phone,city,address,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',pointId,companyId,mid,label,contact,phone,city,address,clean(data.notes,400),now());audit(companyId,user.id,'PICKUP_POINT_CREATED','pickup_point',pointId,{merchantId:mid});});return send(res,201,{id:pointId});
  }
 }
 if(path==='/api/workflow/vehicles'){
  requirePermission(user,'pickups.manage','routes.manage','vehicles.self');
  if(method==='GET')return send(res,200,{vehicles:all('SELECT v.*,u.full_name AS driver_name FROM vehicles v LEFT JOIN users u ON u.id=v.driver_id AND u.company_id=v.company_id WHERE v.company_id=?'+(user.role==='PICKUP_DRIVER'?' AND v.driver_id=?':'')+' ORDER BY v.plate',...user.role==='PICKUP_DRIVER'?[companyId,user.id]:[companyId])});
  if(method==='POST'){
   requirePermission(user,'pickups.manage');const data=await json(ctx.req),plate=clean(data.plate,35).toUpperCase(),kind=data.kind||'CAR',ownership=data.ownership||'DRIVER',driver=data.driverId||null;
   if(!plate||!['CAR','VAN','MOTORCYCLE','TRUCK'].includes(kind)||!['DRIVER','COMPANY'].includes(ownership))throw fail(400,'Véhicule invalide');
   if(driver&&!stmt("SELECT 1 FROM users WHERE id=? AND company_id=? AND role IN ('PICKUP_DRIVER','DRIVER') AND active=1",driver,companyId))throw fail(400,'Conducteur invalide');if(ownership==='DRIVER'&&!driver)throw fail(400,'Le véhicule personnel doit appartenir à un conducteur');
   const vehicleId=id();try{tx(()=>{run('INSERT INTO vehicles(id,company_id,plate,kind,ownership,driver_id,created_at) VALUES(?,?,?,?,?,?,?)',vehicleId,companyId,plate,kind,ownership,driver,now());audit(companyId,user.id,'VEHICLE_CREATED','vehicle',vehicleId);});}catch(e){if(String(e).includes('UNIQUE'))throw fail(409,'Immatriculation déjà enregistrée');throw e;}return send(res,201,{id:vehicleId});
  }
 }
 if(path==='/api/workflow/pickups'){
  requirePermission(user,'pickups.create','pickups.manage','pickups.read','pickups.self','warehouse');
  if(method==='GET'){
   const where=['p.company_id=?'],args=[companyId];if(user.role==='MERCHANT'){where.push('p.merchant_id=?');args.push(user.merchant_id);}if(user.role==='PICKUP_DRIVER'){where.push('p.driver_id=?');args.push(user.id);}
   return send(res,200,{pickups:all(`SELECT p.*,m.name AS merchant_name,pp.label AS point_label,pp.city,pp.address,pp.phone,pp.contact_name,u.full_name AS driver_name,v.plate,COUNT(i.shipment_id) AS expected,SUM(CASE WHEN i.state IN ('COLLECTED','RECEIVED') THEN 1 ELSE 0 END) AS collected,SUM(CASE WHEN i.state='RECEIVED' THEN 1 ELSE 0 END) AS received FROM pickups p JOIN merchants m ON m.id=p.merchant_id JOIN pickup_points pp ON pp.id=p.point_id LEFT JOIN users u ON u.id=p.driver_id LEFT JOIN vehicles v ON v.id=p.vehicle_id LEFT JOIN pickup_items i ON i.pickup_id=p.id AND i.company_id=p.company_id WHERE ${where.join(' AND ')} GROUP BY p.id ORDER BY p.scheduled_at DESC LIMIT 300`,...args)});
  }
  if(method==='POST'){
   requirePermission(user,'pickups.create','pickups.manage');const data=await json(ctx.req),mid=merchantId(ctx,data.merchantId),scheduled=isoDate(data.scheduledAt,'Date prévue'),ids=data.shipmentIds;
   if(!Array.isArray(ids)||!ids.length||ids.length>1000||new Set(ids).size!==ids.length)throw fail(400,'Sélectionnez de 1 à 1000 colis distincts');
   const point=stmt('SELECT * FROM pickup_points WHERE id=? AND company_id=? AND merchant_id=? AND active=1',data.pointId,companyId,mid);if(!point)throw fail(400,'Point de ramassage invalide');
   const pickupId=id(),ref=reference('RAM');
   tx(()=>{
    for(const sid of ids){const s=stmt('SELECT * FROM shipments WHERE id=? AND company_id=? AND merchant_id=?',sid,companyId,mid);if(!s||s.order_source!=='EXTERNAL'||s.status!=='CREATED'||s.reused_return_id)throw fail(409,'Un colis n’est pas éligible à un ramassage externe');if(stmt('SELECT 1 FROM pickup_items WHERE shipment_id=? AND company_id=? AND active=1',sid,companyId))throw fail(409,'Un colis appartient déjà à un ramassage actif');}
    run('INSERT INTO pickups(id,company_id,merchant_id,point_id,reference,scheduled_at,slot,state,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,\'REQUESTED\',?,?,?)',pickupId,companyId,mid,point.id,ref,scheduled,clean(data.slot,100),user.id,now(),now());for(const sid of ids)run('INSERT INTO pickup_items(company_id,pickup_id,shipment_id) VALUES(?,?,?)',companyId,pickupId,sid);
    audit(companyId,user.id,'PICKUP_REQUESTED','pickup',pickupId,{expected:ids.length,merchantId:mid});notify(ctx,{roles:['ADMIN','OPERATIONS','DISPATCHER']},'Nouvelle demande de ramassage '+ref,'pickup',pickupId);
   });return send(res,201,{id:pickupId,reference:ref,state:'REQUESTED'});
  }
 }
 const match=path.match(/^\/api\/workflow\/pickups\/([a-f0-9-]{36})(?:\/(assign|start|scan|complete|cancel|print))?$/);if(!match)return false;
 const pickupId=match[1],action=match[2],p=pickupAccess(ctx,stmt('SELECT p.*,pp.city,pp.address,pp.phone,pp.contact_name,m.name AS merchant_name FROM pickups p JOIN pickup_points pp ON pp.id=p.point_id JOIN merchants m ON m.id=p.merchant_id WHERE p.id=? AND p.company_id=?',pickupId,companyId));
 const detail=()=>({pickup:stmt('SELECT * FROM pickups WHERE id=? AND company_id=?',pickupId,companyId),point:{city:p.city,address:p.address,phone:p.phone,contactName:p.contact_name,merchantName:p.merchant_name},items:all('SELECT i.*,s.tracking,s.recipient,s.city,s.status FROM pickup_items i JOIN shipments s ON s.id=i.shipment_id AND s.company_id=i.company_id WHERE i.pickup_id=? AND i.company_id=? ORDER BY s.tracking',pickupId,companyId)});
 if(method==='GET'&&!action)return send(res,200,detail());
 if(method==='GET'&&action==='print'){const d=detail();return html(res,documentHtml('Bon de ramassage '+p.reference,`<p>${esc(p.merchant_name)} · ${esc(p.contact_name)} · ${esc(p.phone)}</p><p>${esc(p.address)} · ${esc(p.city)}</p><p>Prévu le ${esc(p.scheduled_at)} · ${esc(p.slot)}</p><table><tr><th>Tracking</th><th>Destination</th><th>Collecte</th><th>Réception warehouse</th></tr>${d.items.map(i=>`<tr><td>${esc(i.tracking)}</td><td>${esc(i.city)}</td><td>${esc(i.collected_at||i.state)}</td><td>${esc(i.received_at||'En attente')}</td></tr>`).join('')}</table>`));}
 if(method!=='POST')throw fail(405,'Méthode non autorisée');const data=await json(ctx.req);
 if(action==='assign'){
  requirePermission(user,'pickups.manage');if(!['REQUESTED','ASSIGNED','FAILED'].includes(p.state))throw fail(409,'Ramassage déjà commencé ou terminé');
  const driver=stmt("SELECT id FROM users WHERE id=? AND company_id=? AND role='PICKUP_DRIVER' AND active=1",data.driverId,companyId),vehicle=stmt('SELECT * FROM vehicles WHERE id=? AND company_id=? AND active=1',data.vehicleId,companyId);
  if(!driver||!vehicle||(vehicle.ownership==='DRIVER'&&vehicle.driver_id!==driver.id))throw fail(400,'Ramasseur ou véhicule incompatible');
  if(p.state==='FAILED')throw fail(409,'Créez une nouvelle demande pour les colis non collectés');
  tx(()=>{run("UPDATE pickups SET driver_id=?,vehicle_id=?,state='ASSIGNED',updated_at=? WHERE id=? AND company_id=?",driver.id,vehicle.id,now(),pickupId,companyId);audit(companyId,user.id,'PICKUP_ASSIGNED','pickup',pickupId,{driverId:driver.id,vehicleId:vehicle.id});notify(ctx,{users:[driver.id]},'Ramassage affecté : '+p.reference,'pickup',pickupId);notify(ctx,{merchant:p.merchant_id},'Ramasseur affecté à votre demande','pickup',pickupId);});
 }else if(action==='start'){
  if(user.role!=='PICKUP_DRIVER')requirePermission(user,'pickups.manage');if(p.state!=='ASSIGNED')throw fail(409,'Ramassage non affecté');if(stmt("SELECT 1 FROM pickups WHERE company_id=? AND id<>? AND state='IN_PROGRESS' AND (driver_id=? OR vehicle_id=?)",companyId,p.id,p.driver_id,p.vehicle_id)||stmt("SELECT 1 FROM delivery_routes WHERE company_id=? AND state='ACTIVE' AND (driver_id=? OR vehicle_id=?)",companyId,p.driver_id,p.vehicle_id))throw fail(409,'Conducteur ou véhicule déjà en mission');tx(()=>{run("UPDATE pickups SET state='IN_PROGRESS',updated_at=? WHERE id=? AND company_id=?",now(),pickupId,companyId);audit(companyId,user.id,'PICKUP_STARTED','pickup',pickupId);});
 }else if(action==='scan'){
  if(user.role!=='PICKUP_DRIVER')requirePermission(user,'pickups.manage');if(p.state!=='IN_PROGRESS')throw fail(409,'Démarrez le ramassage avant le scan');
  tx(()=>{const s=scanShipment(ctx,data.scan),item=stmt('SELECT * FROM pickup_items WHERE pickup_id=? AND shipment_id=? AND company_id=?',pickupId,s.id,companyId);if(!item||s.merchant_id!==p.merchant_id)throw fail(409,'Colis absent du bon de ce marchand');if(item.state!=='EXPECTED'||s.status!=='CREATED')throw fail(409,'Colis déjà collecté ou non disponible');
   run("UPDATE pickup_items SET state='COLLECTED',collected_at=? WHERE pickup_id=? AND shipment_id=? AND company_id=?",now(),pickupId,s.id,companyId);run('UPDATE shipments SET collected_at=? WHERE id=? AND company_id=?',now(),s.id,companyId);parcelEvent(ctx,s,'COLLECTED','Collecté chez le marchand — '+p.reference,'PICKUP');audit(companyId,user.id,'PICKUP_PARCEL_COLLECTED','shipment',s.id,{pickupId,vehicleId:p.vehicle_id});});
 }else if(action==='complete'){
  if(user.role!=='PICKUP_DRIVER')requirePermission(user,'pickups.manage');if(p.state!=='IN_PROGRESS')throw fail(409,'Ramassage non commencé');
  const items=all('SELECT state FROM pickup_items WHERE pickup_id=? AND company_id=?',pickupId,companyId),missing=items.filter(i=>i.state==='EXPECTED').length,collected=items.filter(i=>['COLLECTED','RECEIVED'].includes(i.state)).length,note=clean(data.note,400),receiver=clean(data.receiverName,120);
  if(!receiver||missing&&note.length<5)throw fail(400,'Nom du remettant et motif des colis manquants requis');
  const state=collected===0?'FAILED':!items.some(i=>i.state==='COLLECTED')?'RECEIVED':missing?'PARTIAL':'COLLECTED';
  tx(()=>{run("UPDATE pickup_items SET state='MISSING',note=?,active=0 WHERE pickup_id=? AND company_id=? AND state='EXPECTED'",note,pickupId,companyId);run('UPDATE pickups SET state=?,receiver_name=?,completion_note=?,updated_at=? WHERE id=? AND company_id=?',state,receiver,note,now(),pickupId,companyId);audit(companyId,user.id,'PICKUP_COMPLETED','pickup',pickupId,{collected,missing,state});notify(ctx,{merchant:p.merchant_id},`Ramassage ${p.reference} : ${collected} collecté(s), ${missing} manquant(s)`,'pickup',pickupId);});
 }else if(action==='cancel'){
  if(user.role!=='MERCHANT')requirePermission(user,'pickups.manage');if(!['REQUESTED','ASSIGNED'].includes(p.state))throw fail(409,'Annulation impossible après début de collecte');if(clean(data.reason).length<5)throw fail(400,'Motif requis');tx(()=>{run("UPDATE pickups SET state='CANCELLED',completion_note=?,updated_at=? WHERE id=? AND company_id=?",clean(data.reason),now(),pickupId,companyId);run('UPDATE pickup_items SET active=0 WHERE pickup_id=? AND company_id=?',pickupId,companyId);audit(companyId,user.id,'PICKUP_CANCELLED','pickup',pickupId);if(p.driver_id)notify(ctx,{users:[p.driver_id]},'Ramassage annulé '+p.reference,'pickup',pickupId);});
 }else throw fail(404,'Action de ramassage inconnue');
 return send(res,200,detail());
}
