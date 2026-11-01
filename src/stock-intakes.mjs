import {id,now} from './db.mjs';
import {requirePermission,has} from './access.mjs';
import {clean,fail,reference,integer,isoDate,notify,html,documentHtml,esc} from './workflow-shared.mjs';
import {stockMovement,activeVehicleMission} from './stock-ledger.mjs';
import {newStockLot,requestHash,requestKey} from './warehouse-shared.mjs';

function intakeScope(ctx){
 requirePermission(ctx.user,'intakes.create','intakes.manage','intakes.receive','intakes.self','intakes.read');
 if(ctx.user.role==='MERCHANT')return {sql:' AND i.merchant_id=?',args:[ctx.user.merchant_id]};
 if(ctx.user.role==='PICKUP_DRIVER')return {sql:' AND i.driver_id=?',args:[ctx.user.id]};
 return {sql:'',args:[]};
}
function intake(ctx,intakeId){
 const scope=intakeScope(ctx),i=ctx.stmt(`SELECT i.*,m.name AS merchant_name,p.label AS point_label,p.address,p.city,p.phone,p.contact_name,u.full_name AS driver_name,v.plate FROM stock_intakes i JOIN merchants m ON m.id=i.merchant_id AND m.company_id=i.company_id LEFT JOIN pickup_points p ON p.id=i.point_id AND p.company_id=i.company_id LEFT JOIN users u ON u.id=i.driver_id AND u.company_id=i.company_id LEFT JOIN vehicles v ON v.id=i.vehicle_id AND v.company_id=i.company_id WHERE i.id=? AND i.company_id=?${scope.sql}`,intakeId,ctx.companyId,...scope.args);
 if(!i)throw fail(404,'Bon d’entrée introuvable dans votre périmètre');return i;
}
function intakeDetail(ctx,intakeId){
 const i=intake(ctx,intakeId),items=ctx.all(`SELECT l.*,p.sku,p.name,p.barcode,COALESCE(SUM(r.accepted_quantity),0) AS accepted,COALESCE(SUM(r.damaged_quantity),0) AS damaged FROM stock_intake_lines l JOIN inventory_products p ON p.id=l.product_id AND p.company_id=l.company_id LEFT JOIN stock_intake_receipt_lines r ON r.line_id=l.id AND r.company_id=l.company_id WHERE l.intake_id=? AND l.company_id=? GROUP BY l.id ORDER BY p.sku`,intakeId,ctx.companyId).map(l=>({...l,gap:l.expected_quantity-l.accepted-l.damaged})),receipts=ctx.all('SELECT * FROM stock_intake_receipts WHERE intake_id=? AND company_id=? ORDER BY created_at,id',intakeId,ctx.companyId);
 return {intake:i,items,receipts,summary:{expected:items.reduce((n,l)=>n+l.expected_quantity,0),accepted:items.reduce((n,l)=>n+l.accepted,0),damaged:items.reduce((n,l)=>n+l.damaged,0),boxes:receipts.reduce((n,r)=>n+r.boxes,0),missing:items.reduce((n,l)=>n+Math.max(0,l.gap),0),extra:items.reduce((n,l)=>n+Math.max(0,-l.gap),0)}};
}
export async function stockIntakeRoute(ctx){
 const {path,method,url,user,companyId,stmt,all,run,tx,json,send,res,audit}=ctx;
 if(path==='/api/workflow/stock-intakes'){
  const scope=intakeScope(ctx);
  if(method==='GET')return send(res,200,{intakes:all(`SELECT i.*,m.name AS merchant_name,p.city,u.full_name AS driver_name,v.plate,(SELECT COALESCE(SUM(l.expected_quantity),0) FROM stock_intake_lines l WHERE l.intake_id=i.id AND l.company_id=i.company_id) AS expected,(SELECT COALESCE(SUM(l.accepted_quantity),0) FROM stock_intake_receipt_lines l JOIN stock_intake_receipts r ON r.id=l.receipt_id AND r.company_id=l.company_id WHERE r.intake_id=i.id AND r.company_id=i.company_id) AS accepted FROM stock_intakes i JOIN merchants m ON m.id=i.merchant_id AND m.company_id=i.company_id LEFT JOIN pickup_points p ON p.id=i.point_id AND p.company_id=i.company_id LEFT JOIN users u ON u.id=i.driver_id AND u.company_id=i.company_id LEFT JOIN vehicles v ON v.id=i.vehicle_id AND v.company_id=i.company_id WHERE i.company_id=?${scope.sql} ORDER BY i.created_at DESC,i.id LIMIT 300`,companyId,...scope.args)});
  if(method==='POST'){
   requirePermission(user,'intakes.create','intakes.manage');const data=await json(ctx.req),mid=user.role==='MERCHANT'?user.merchant_id:data.merchantId,mode=data.mode||'DROP_OFF',boxes=integer(data.expectedBoxes,1,10000),scheduled=data.scheduledAt?isoDate(data.scheduledAt):null;
   if(user.role==='MERCHANT'&&data.merchantId&&data.merchantId!==mid)throw fail(403,'Autre marchand interdit');
   if(!stmt('SELECT 1 FROM merchants WHERE id=? AND company_id=?',mid,companyId))throw fail(400,'Marchand invalide');
   if(!['DROP_OFF','COLLECTION'].includes(mode))throw fail(400,'Mode d’approvisionnement invalide');
   if(mode==='COLLECTION'&&(!scheduled||!stmt('SELECT 1 FROM pickup_points WHERE id=? AND company_id=? AND merchant_id=? AND active=1',data.pointId,companyId,mid)))throw fail(400,'Point du marchand et rendez-vous requis pour la collecte de stock');
   if(!Array.isArray(data.items)||!data.items.length||data.items.length>100||new Set(data.items.map(x=>x?.productId)).size!==data.items.length)throw fail(400,'De 1 à 100 produits distincts requis');
   const items=data.items.map(x=>({productId:clean(x?.productId,40),quantity:integer(x?.quantity,1,1000000)})),intakeId=id(),ref=reference('ENT');
   tx(()=>{for(const l of items)if(!stmt('SELECT 1 FROM inventory_products WHERE id=? AND company_id=? AND merchant_id=?',l.productId,companyId,mid))throw fail(400,'Produit absent du catalogue de ce marchand');
    run('INSERT INTO stock_intakes(id,company_id,merchant_id,reference,mode,point_id,scheduled_at,expected_boxes,note,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',intakeId,companyId,mid,ref,mode,mode==='COLLECTION'?data.pointId:null,scheduled,boxes,clean(data.note,500),user.id,now(),now());
    for(const l of items)run('INSERT INTO stock_intake_lines VALUES(?,?,?,?,?)',id(),companyId,intakeId,l.productId,l.quantity);
    audit(companyId,user.id,'STOCK_INTAKE_REQUESTED','stock_intake',intakeId,{merchantId:mid,mode,boxes});notify(ctx,{roles:['ADMIN','OPERATIONS','DISPATCHER','WAREHOUSE']},'Approvisionnement demandé '+ref,'stock_intake',intakeId);
   });return send(res,201,intakeDetail(ctx,intakeId));
  }
 }
 const match=path.match(/^\/api\/workflow\/stock-intakes\/([a-f0-9-]{36})(?:\/(assign|start|collect|receive|close|cancel|fail|print))?$/);if(!match)return false;
 const intakeId=match[1],action=match[2],i=intake(ctx,intakeId);
 if(method==='GET'&&!action)return send(res,200,intakeDetail(ctx,intakeId));
 if(method==='GET'&&action==='print'){
  const d=intakeDetail(ctx,intakeId);return html(res,documentHtml('Bon d’entrée stock '+i.reference,`<p>Marchand : ${esc(i.merchant_name)} · ${esc(i.mode==='COLLECTION'?'Collecte chez le marchand':'Dépôt au warehouse')} · ${esc(i.state)}</p><p>${esc(i.address||'')} ${esc(i.city||'')} · ${esc(i.driver_name||'')} · ${esc(i.plate||'')}</p><p>Cartons annoncés : ${i.expected_boxes} · collectés : ${i.collected_boxes??'—'} · réceptionnés : ${d.summary.boxes}</p><p>Preuve de collecte : ${esc(i.collection_proof||'—')} · remettant : ${esc(i.collected_by||'—')}</p><table><tr><th>SKU / produit</th><th>Annoncé</th><th>Conforme</th><th>Quarantaine</th><th>Manquant (+) / surplus (−)</th></tr>${d.items.map(l=>`<tr><td>${esc(l.sku)} · ${esc(l.name)}</td><td>${l.expected_quantity}</td><td>${l.accepted}</td><td>${l.damaged}</td><td>${l.gap}</td></tr>`).join('')}</table><h2>Réceptions physiques</h2>${d.receipts.map(r=>`<p>${esc(r.created_at)} · ${r.boxes} carton(s) · réceptionnaire : ${esc(r.receiver_name)} · preuve : ${esc(r.proof_reference)} · ${esc(r.note)}</p>`).join('')||'<p>Aucune réception warehouse.</p>'}<p>Clôture et écarts : ${esc(i.closing_note||'Non clôturé')}</p>`));
 }
 if(method!=='POST')throw fail(405,'Méthode non autorisée');const data=await json(ctx.req);
 if(action==='assign'){
  requirePermission(user,'intakes.manage');if(i.mode!=='COLLECTION'||!['REQUESTED','ASSIGNED'].includes(i.state))throw fail(409,'Collecte de stock non affectable');
  const driver=stmt("SELECT id FROM users WHERE id=? AND company_id=? AND role='PICKUP_DRIVER' AND active=1",data.driverId,companyId),vehicle=stmt('SELECT * FROM vehicles WHERE id=? AND company_id=? AND active=1',data.vehicleId,companyId);
  if(!driver||!vehicle||vehicle.ownership==='DRIVER'&&vehicle.driver_id!==driver.id)throw fail(400,'Ramasseur ou véhicule incompatible');
  tx(()=>{run("UPDATE stock_intakes SET state='ASSIGNED',driver_id=?,vehicle_id=?,updated_at=? WHERE id=? AND company_id=?",driver.id,vehicle.id,now(),i.id,companyId);notify(ctx,{users:[driver.id]},'Collecte de stock affectée '+i.reference,'stock_intake',i.id);audit(companyId,user.id,'STOCK_INTAKE_ASSIGNED','stock_intake',i.id,{driverId:driver.id,vehicleId:vehicle.id});});
 }else if(action==='start'){
  if(user.role!=='PICKUP_DRIVER')requirePermission(user,'intakes.manage');if(i.state!=='ASSIGNED'||i.mode!=='COLLECTION')throw fail(409,'Collecte non affectée');
  if(activeVehicleMission(ctx,i.driver_id,i.vehicle_id))throw fail(409,'Conducteur ou véhicule déjà en mission');
  tx(()=>{run("UPDATE stock_intakes SET state='COLLECTING',updated_at=? WHERE id=? AND company_id=?",now(),i.id,companyId);audit(companyId,user.id,'STOCK_INTAKE_STARTED','stock_intake',i.id);});
 }else if(action==='collect'){
  if(user.role!=='PICKUP_DRIVER')requirePermission(user,'intakes.manage');if(i.state!=='COLLECTING')throw fail(409,'Démarrez la mission avant de confirmer la collecte');
  const boxes=integer(data.boxes,1,10000),sender=clean(data.senderName,120),proof=clean(data.proofReference,180),note=clean(data.note,500);
  if(!sender||!proof||boxes!==i.expected_boxes&&note.length<5)throw fail(400,'Remettant, preuve de collecte et motif de tout écart de cartons requis');
  tx(()=>{run("UPDATE stock_intakes SET state='COLLECTED',collected_boxes=?,collected_by=?,collection_proof=?,closing_note=?,updated_at=? WHERE id=? AND company_id=?",boxes,sender,proof,note,now(),i.id,companyId);notify(ctx,{merchant:i.merchant_id},'Stock collecté, réception warehouse attendue : '+i.reference,'stock_intake',i.id);audit(companyId,user.id,'STOCK_INTAKE_COLLECTED','stock_intake',i.id,{boxes,proof});});
 }else if(action==='receive'){
  requirePermission(user,'intakes.receive');const key=requestKey(data.requestId),hash=requestHash(data),previous=stmt('SELECT * FROM stock_intake_receipts WHERE company_id=? AND request_id=?',companyId,key);
  if(previous){if(previous.intake_id!==i.id||previous.created_by!==user.id||previous.request_hash!==hash)throw fail(409,'Identifiant de réception déjà utilisé avec un autre contenu');return send(res,200,{...intakeDetail(ctx,i.id),duplicate:true});}
  if(!(i.mode==='DROP_OFF'?['REQUESTED','PARTIAL']:['COLLECTED','PARTIAL']).includes(i.state))throw fail(409,'Bon non réceptionnable : confirmez la collecte ou vérifiez sa clôture');
  const boxes=integer(data.boxes,1,10000),receiver=clean(data.receiverName,120),proof=clean(data.proofReference,180),note=clean(data.note,500);
  if(!receiver||!proof||!Array.isArray(data.items)||!data.items.length||data.items.length>100||new Set(data.items.map(x=>x?.lineId)).size!==data.items.length)throw fail(400,'Réceptionnaire, preuve et lignes distinctes requis');
  const d=intakeDetail(ctx,i.id),lines=data.items.map(l=>({lineId:clean(l?.lineId,40),accepted:integer(l?.acceptedQuantity??0,0,1000000),damaged:integer(l?.damagedQuantity??0,0,1000000),location:clean(l?.location,70)||'ENTREPOT'}));
  if(!lines.some(l=>l.accepted+l.damaged>0)&&note.length<5)throw fail(400,'Justifiez la réception de cartons vides');
  if(d.summary.boxes+boxes>(i.collected_boxes??i.expected_boxes)&&note.length<5)throw fail(400,'Justifiez les cartons supplémentaires');
  for(const l of lines){const expected=d.items.find(x=>x.id===l.lineId);if(!expected)throw fail(400,'Ligne absente du bon d’entrée');if(expected.accepted+expected.damaged+l.accepted+l.damaged>expected.expected_quantity&&note.length<5)throw fail(400,'Justifiez les unités supplémentaires');}
  const receiptId=id();tx(()=>{
   run('INSERT INTO stock_intake_receipts(id,company_id,intake_id,boxes,receiver_name,proof_reference,note,request_id,created_by,created_at,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)',receiptId,companyId,i.id,boxes,receiver,proof,note,key,user.id,now(),hash);
   for(const l of lines){const productId=d.items.find(x=>x.id===l.lineId).product_id,lotId=l.accepted?newStockLot(ctx,{productId,quantity:l.accepted,location:l.location,entityType:'stock_intake',entityId:i.id,note:proof,eventKey:'INTAKE:'+receiptId+':'+l.lineId}):null;
    run('INSERT INTO stock_intake_receipt_lines VALUES(?,?,?,?,?,?)',companyId,receiptId,l.lineId,l.accepted,l.damaged,lotId);
    if(l.damaged){const quarantineId=id();run('INSERT INTO stock_quarantine VALUES(?,?,?,?,?,?,?,?,?,?)',quarantineId,companyId,i.merchant_id,productId,receiptId,l.damaged,l.damaged,l.location+' / QUARANTAINE',note,now());stockMovement(ctx,{productId,kind:'QUARANTINE',quarantine:l.damaged,entityType:'quarantine',entityId:quarantineId,note:proof,eventKey:'QUARANTINE:'+quarantineId});}
   }
   run("UPDATE stock_intakes SET state='PARTIAL',updated_at=? WHERE id=? AND company_id=?",now(),i.id,companyId);audit(companyId,user.id,'STOCK_INTAKE_RECEIVED','stock_intake',i.id,{receiptId,boxes});notify(ctx,{merchant:i.merchant_id},'Réception stock enregistrée '+i.reference,'stock_intake',i.id);
  });return send(res,201,{...intakeDetail(ctx,i.id),receiptId});
 }else if(action==='close'){
  requirePermission(user,'intakes.receive');if(i.state!=='PARTIAL')throw fail(409,'Enregistrez la réception physique avant la clôture');
  const d=intakeDetail(ctx,i.id),note=clean(data.note,500),discrepancy=d.items.some(l=>l.gap!==0||l.damaged>0)||d.summary.boxes!==i.expected_boxes||i.mode==='COLLECTION'&&d.summary.boxes!==i.collected_boxes;
  if(discrepancy&&note.length<5)throw fail(400,'Décrivez les manquants, surplus, dommages ou écarts de cartons avant clôture');
  tx(()=>{run("UPDATE stock_intakes SET state='RECEIVED',closing_note=?,closed_at=?,updated_at=? WHERE id=? AND company_id=?",note,now(),now(),i.id,companyId);audit(companyId,user.id,'STOCK_INTAKE_CLOSED','stock_intake',i.id,{...d.summary,note});notify(ctx,{merchant:i.merchant_id},'Bon d’entrée clôturé '+(discrepancy?'avec écarts : ':'conforme : ')+i.reference,'stock_intake',i.id);});
 }else if(action==='cancel'||action==='fail'){
  if(action==='cancel'&&user.role==='MERCHANT'){if(i.merchant_id!==user.merchant_id)throw fail(403,'Autre marchand interdit');}else if(!(action==='fail'&&user.role==='PICKUP_DRIVER'))requirePermission(user,'intakes.manage');
  if(!(action==='fail'?['COLLECTING']:['REQUESTED','ASSIGNED']).includes(i.state))throw fail(409,'État incompatible : du stock peut déjà être en transport ou réceptionné');const note=clean(data.note,500);if(note.length<5)throw fail(400,'Motif détaillé requis');
  tx(()=>{run('UPDATE stock_intakes SET state=?,closing_note=?,closed_at=?,updated_at=? WHERE id=? AND company_id=?',action==='fail'?'FAILED':'CANCELLED',note,now(),now(),i.id,companyId);audit(companyId,user.id,'STOCK_INTAKE_'+(action==='fail'?'FAILED':'CANCELLED'),'stock_intake',i.id,{note});notify(ctx,{merchant:i.merchant_id},'Collecte de stock interrompue '+i.reference,'stock_intake',i.id);if(i.driver_id)notify(ctx,{users:[i.driver_id]},'Collecte de stock interrompue '+i.reference,'stock_intake',i.id);});
 }else throw fail(404,'Action de bon d’entrée inconnue');
 return send(res,200,intakeDetail(ctx,i.id));
}
