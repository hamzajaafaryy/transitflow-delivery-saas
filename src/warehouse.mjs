import {id,now} from './db.mjs';
import {requirePermission,requireShipmentAccess} from './access.mjs';
import {clean,fail,reference,integer,notify,html,documentHtml,esc} from './workflow-shared.mjs';
import {stockMovement} from './stock-ledger.mjs';
import {stockScope,createProduct,newStockLot,requestKey,requestHash} from './warehouse-shared.mjs';
import {stockIntakeRoute} from './stock-intakes.mjs';

export function pickingDetail(ctx,shipmentId){
 const s=requireShipmentAccess(ctx,ctx.stmt('SELECT id,company_id,merchant_id,tracking,order_source,status,ramassed_at,hold_reason FROM shipments WHERE id=? AND company_id=?',shipmentId,ctx.companyId));
 if(s.order_source!=='STOCK')throw fail(409,'Le contrôle produits concerne les commandes stock');
 const items=ctx.all(`SELECT p.id AS product_id,p.sku,p.name,p.barcode,SUM(a.quantity) AS expected,GROUP_CONCAT(DISTINCT l.location) AS locations,(SELECT COALESCE(SUM(x.quantity),0) FROM picking_scans x WHERE x.company_id=p.company_id AND x.shipment_id=? AND x.product_id=p.id) AS scanned FROM stock_allocations a JOIN inventory_products p ON p.id=a.product_id AND p.company_id=a.company_id JOIN stock_lots l ON l.id=a.lot_id AND l.company_id=a.company_id WHERE a.company_id=? AND a.shipment_id=? AND a.state<>'RELEASED' GROUP BY p.id ORDER BY p.sku`,shipmentId,ctx.companyId,shipmentId);
 return {shipment:s,items,complete:items.length>0&&items.every(l=>l.expected===l.scanned),summary:{expected:items.reduce((n,l)=>n+l.expected,0),scanned:items.reduce((n,l)=>n+l.scanned,0)}};
}
function countDetail(ctx,countId){
 const scope=stockScope(ctx,'c'),c=ctx.stmt(`SELECT c.*,m.name AS merchant_name,u.full_name AS creator_name,v.full_name AS approver_name FROM stock_counts c LEFT JOIN merchants m ON m.id=c.merchant_id AND m.company_id=c.company_id JOIN users u ON u.id=c.created_by AND u.company_id=c.company_id LEFT JOIN users v ON v.id=c.applied_by AND v.company_id=c.company_id WHERE c.id=? AND c.company_id=?${scope.sql}`,countId,ctx.companyId,...scope.args);if(!c)throw fail(404,'Inventaire introuvable');
 return {count:c,items:ctx.all('SELECT x.*,p.sku,p.name,l.location,l.quantity_on_hand AS current_on_hand,l.quantity_reserved AS current_reserved FROM stock_count_lines x JOIN stock_lots l ON l.id=x.lot_id AND l.company_id=x.company_id JOIN inventory_products p ON p.id=l.product_id AND p.company_id=l.company_id WHERE x.count_id=? AND x.company_id=? ORDER BY p.sku,l.location,l.received_at,l.id',c.id,ctx.companyId)};
}
function countLots(ctx,{merchant_id,location}){return ctx.all('SELECT l.* FROM stock_lots l JOIN inventory_products p ON p.id=l.product_id AND p.company_id=l.company_id WHERE l.company_id=?'+(merchant_id?' AND p.merchant_id=?':'')+(location?' AND l.location=?':'')+' ORDER BY l.id',ctx.companyId,...merchant_id?[merchant_id]:[],...location?[location]:[]);}
export async function warehouseRoute(ctx){
 const {path,method,url,user,companyId,stmt,all,run,tx,json,send,res,audit}=ctx;
 if(path.startsWith('/api/workflow/stock-intakes'))return stockIntakeRoute(ctx);
 if(path==='/api/workflow/catalog'){
  requirePermission(user,'catalog.create','inventory.read','intakes.manage','intakes.receive','intakes.read');
  if(method==='GET'){const mid=user.role==='MERCHANT'?user.merchant_id:url.searchParams.get('merchantId');return send(res,200,{products:all('SELECT p.id,p.sku,p.name,p.barcode,p.merchant_id,p.low_stock_threshold,m.name AS merchant_name FROM inventory_products p LEFT JOIN merchants m ON m.id=p.merchant_id AND m.company_id=p.company_id WHERE p.company_id=?'+(mid?' AND p.merchant_id=?':'')+' ORDER BY p.sku,p.id LIMIT 2000',companyId,...mid?[mid]:[])});}
  if(method==='POST'){requirePermission(user,'catalog.create','inventory.write');const data=await json(ctx.req);return send(res,201,tx(()=>createProduct(ctx,data)));}
 }
 const pick=path.match(/^\/api\/workflow\/picking\/([a-f0-9-]{36})(?:\/(scan))?$/);
 if(pick){
  requirePermission(user,'warehouse');const d=pickingDetail(ctx,pick[1]);
  if(method==='GET'&&!pick[2])return send(res,200,d);
  if(method==='POST'&&pick[2]==='scan'){
   const data=await json(ctx.req),key=requestKey(data.requestId),hash=requestHash(data),previous=stmt('SELECT * FROM picking_scans WHERE company_id=? AND request_id=?',companyId,key);
   if(previous){if(previous.shipment_id!==d.shipment.id||previous.actor_id!==user.id||previous.request_hash!==hash)throw fail(409,'Identifiant de scan déjà utilisé avec un autre contenu');return send(res,200,{...d,duplicate:true});}
   if(d.shipment.ramassed_at||!['CREATED','ASSIGNED_AGENCY','EXPORTED'].includes(d.shipment.status))throw fail(409,'Préparation déjà sortie ou commande clôturée');
   if(d.shipment.hold_reason)throw fail(409,'Préparation bloquée : '+d.shipment.hold_reason);
   const value=clean(data.productScan,100),qty=integer(data.quantity??1,1,100000),matches=d.items.filter(p=>[p.product_id,p.sku,p.barcode].filter(Boolean).some(x=>x.toUpperCase()===value.toUpperCase()));
   if(matches.length!==1)throw fail(409,matches.length?'Code produit ambigu : utilisez son ID':'Produit absent de cette commande');const p=matches[0];if(p.scanned+qty>p.expected)throw fail(409,'Quantité scannée supérieure au bon stock');
   tx(()=>{run('INSERT INTO picking_scans(id,company_id,shipment_id,product_id,quantity,request_id,actor_id,created_at,request_hash) VALUES(?,?,?,?,?,?,?,?,?)',id(),companyId,d.shipment.id,p.product_id,qty,key,user.id,now(),hash);audit(companyId,user.id,'PICKING_PRODUCT_SCANNED','shipment',d.shipment.id,{productId:p.product_id,quantity:qty});});return send(res,201,pickingDetail(ctx,d.shipment.id));
  }
 }
 if(path==='/api/workflow/stock-movements'&&method==='GET'){
  const scope=stockScope(ctx),where=['m.company_id=?'+scope.sql],args=[companyId,...scope.args];
  if(user.role==='MERCHANT'){where.push('m.merchant_id=?');args.push(user.merchant_id);}
  if(url.searchParams.get('productId')){where.push('m.product_id=?');args.push(url.searchParams.get('productId'));}
  const limit=integer(url.searchParams.get('limit')||100,1,500),offset=integer(url.searchParams.get('offset')||0,0,1000000);
  const movements=all(`SELECT m.*,p.sku,p.name,l.location,u.full_name AS actor_name,t.name AS merchant_name FROM stock_movements m JOIN inventory_products p ON p.id=m.product_id AND p.company_id=m.company_id LEFT JOIN stock_lots l ON l.id=m.lot_id AND l.company_id=m.company_id LEFT JOIN users u ON u.id=m.actor_id AND u.company_id=m.company_id LEFT JOIN merchants t ON t.id=m.merchant_id AND t.company_id=m.company_id WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC,m.rowid DESC LIMIT ? OFFSET ?`,...args,limit,offset),total=stmt(`SELECT COUNT(*) AS n FROM stock_movements m JOIN inventory_products p ON p.id=m.product_id AND p.company_id=m.company_id WHERE ${where.join(' AND ')}`,...args).n;
  return send(res,200,{movements,total,limit,offset});
 }
 if(path==='/api/workflow/quarantine'&&method==='GET'){
  const scope=stockScope(ctx,'q');return send(res,200,{quarantine:all(`SELECT q.*,p.sku,p.name,m.name AS merchant_name,i.reference AS intake_reference FROM stock_quarantine q JOIN inventory_products p ON p.id=q.product_id AND p.company_id=q.company_id JOIN merchants m ON m.id=q.merchant_id AND m.company_id=q.company_id JOIN stock_intake_receipts r ON r.id=q.receipt_id AND r.company_id=q.company_id JOIN stock_intakes i ON i.id=r.intake_id AND i.company_id=r.company_id WHERE q.company_id=?${scope.sql} ORDER BY q.quantity_remaining>0 DESC,q.created_at DESC LIMIT 500`,companyId,...scope.args)});
 }
 const quarantine=path.match(/^\/api\/workflow\/quarantine\/([a-f0-9-]{36})(?:\/(dispose))?$/);
 if(quarantine){
  const scope=stockScope(ctx,'q'),q=stmt('SELECT q.*,p.sku,p.name FROM stock_quarantine q JOIN inventory_products p ON p.id=q.product_id AND p.company_id=q.company_id WHERE q.id=? AND q.company_id=?'+scope.sql,quarantine[1],companyId,...scope.args);if(!q)throw fail(404,'Lot de quarantaine introuvable');
  const detail=()=>({quarantine:stmt('SELECT * FROM stock_quarantine WHERE id=? AND company_id=?',q.id,companyId),actions:all('SELECT a.*,u.full_name AS actor_name FROM quarantine_actions a JOIN users u ON u.id=a.created_by AND u.company_id=a.company_id WHERE a.quarantine_id=? AND a.company_id=? ORDER BY a.created_at',q.id,companyId)});
  if(method==='GET'&&!quarantine[2])return send(res,200,detail());
  if(method==='POST'&&quarantine[2]==='dispose'){
   requirePermission(user,'inventory.approve');const data=await json(ctx.req),key=requestKey(data.requestId),hash=requestHash(data),previous=stmt('SELECT * FROM quarantine_actions WHERE company_id=? AND request_id=?',companyId,key);
   if(previous){if(previous.quarantine_id!==q.id||previous.created_by!==user.id||previous.request_hash!==hash)throw fail(409,'Identifiant de traitement déjà utilisé');return send(res,200,{...detail(),duplicate:true});}
   const kind=data.kind,quantity=integer(data.quantity,1,1000000),note=clean(data.note,500),proof=clean(data.proofReference,180),receiver=clean(data.receiverName,120),location=clean(data.location,70)||'ENTREPOT';
   if(!['RELEASE','RETURN','DISCARD'].includes(kind)||note.length<5||!proof||kind==='RETURN'&&!receiver)throw fail(400,'Décision, motif, preuve et destinataire si retour requis');if(quantity>q.quantity_remaining)throw fail(409,'Quantité supérieure au solde en quarantaine');const actionId=id();
   tx(()=>{run('UPDATE stock_quarantine SET quantity_remaining=quantity_remaining-? WHERE id=? AND company_id=?',quantity,q.id,companyId);const lotId=kind==='RELEASE'?newStockLot(ctx,{productId:q.product_id,quantity,location,kind:'QUARANTINE_RELEASE',quarantine:-quantity,entityType:'quarantine',entityId:q.id,note,eventKey:'QUARANTINE_ACTION:'+actionId}):null;
    if(!lotId)stockMovement(ctx,{productId:q.product_id,kind:'QUARANTINE_'+kind,quarantine:-quantity,entityType:'quarantine',entityId:q.id,note,eventKey:'QUARANTINE_ACTION:'+actionId});
    run('INSERT INTO quarantine_actions(id,company_id,quarantine_id,kind,quantity,note,proof_reference,receiver_name,lot_id,created_by,created_at,request_id,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',actionId,companyId,q.id,kind,quantity,note,proof,receiver||null,lotId,user.id,now(),key,hash);audit(companyId,user.id,'QUARANTINE_'+kind,'quarantine',q.id,{quantity,note,proof});notify(ctx,{merchant:q.merchant_id},'Traitement de stock en quarantaine : '+q.sku,'quarantine',q.id);
   });return send(res,201,detail());
  }
 }
 if(path==='/api/workflow/stock-counts'){
  const scope=stockScope(ctx,'c');
  if(method==='GET')return send(res,200,{counts:all('SELECT c.*,m.name AS merchant_name,COUNT(l.lot_id) AS total,SUM(CASE WHEN l.counted_quantity IS NOT NULL THEN 1 ELSE 0 END) AS counted FROM stock_counts c LEFT JOIN merchants m ON m.id=c.merchant_id AND m.company_id=c.company_id LEFT JOIN stock_count_lines l ON l.count_id=c.id AND l.company_id=c.company_id WHERE c.company_id=?'+scope.sql+' GROUP BY c.id ORDER BY c.created_at DESC,c.id LIMIT 300',companyId,...scope.args)});
  if(method==='POST'){
   requirePermission(user,'inventory.write');const data=await json(ctx.req),merchant=data.merchantId||null,location=clean(data.location,70);if(merchant&&!stmt('SELECT 1 FROM merchants WHERE id=? AND company_id=?',merchant,companyId))throw fail(400,'Marchand invalide');
   const countId=id(),ref=reference('INV');tx(()=>{const lots=countLots(ctx,{merchant_id:merchant,location});if(!lots.length||lots.length>500)throw fail(400,'Inventaire de 1 à 500 lots : précisez marchand ou emplacement');run('INSERT INTO stock_counts(id,company_id,merchant_id,reference,location,created_by,created_at) VALUES(?,?,?,?,?,?,?)',countId,companyId,merchant,ref,location,user.id,now());for(const l of lots)run('INSERT INTO stock_count_lines(company_id,count_id,lot_id,expected_on_hand,expected_reserved) VALUES(?,?,?,?,?)',companyId,countId,l.id,l.quantity_on_hand,l.quantity_reserved);audit(companyId,user.id,'STOCK_COUNT_CREATED','stock_count',countId,{merchantId:merchant,location,lots:lots.length});});return send(res,201,countDetail(ctx,countId));
  }
 }
 const count=path.match(/^\/api\/workflow\/stock-counts\/([a-f0-9-]{36})(?:\/(lines|submit|apply|cancel|print))?$/);
 if(count){
  const d=countDetail(ctx,count[1]),c=d.count,action=count[2];if(method==='GET'&&!action)return send(res,200,d);
  if(method==='GET'&&action==='print')return html(res,documentHtml('Inventaire '+c.reference,`<p>${esc(c.merchant_name||'Tous les marchands')} · ${esc(c.location||'Tous emplacements')} · ${esc(c.state)}</p><p>Créé par ${esc(c.creator_name)} · validé par ${esc(c.approver_name||'—')} · ${esc(c.note)}</p><table><tr><th>SKU / lot</th><th>Emplacement</th><th>Théorique</th><th>Réservé</th><th>Compté</th><th>Écart</th></tr>${d.items.map(l=>`<tr><td>${esc(l.sku)}<br>${esc(l.lot_id)}</td><td>${esc(l.location)}</td><td>${l.expected_on_hand}</td><td>${l.expected_reserved}</td><td>${l.counted_quantity??'—'}</td><td>${l.counted_quantity===null?'—':l.counted_quantity-l.expected_on_hand}</td></tr>`).join('')}</table>`));
  if(method!=='POST')throw fail(405,'Méthode non autorisée');requirePermission(user,action==='apply'?'inventory.approve':'inventory.write');const data=await json(ctx.req);
  if(action==='lines'){
   if(c.state!=='COUNTING')throw fail(409,'Inventaire déjà soumis ou clôturé');if(!Array.isArray(data.items)||!data.items.length||data.items.length>500||data.items.some(l=>!l||typeof l!=='object'||Array.isArray(l))||new Set(data.items.map(l=>l.lotId)).size!==data.items.length)throw fail(400,'Lignes distinctes requises');
   tx(()=>{for(const l of data.items){if(!d.items.some(x=>x.lot_id===l.lotId))throw fail(400,'Lot absent de cet inventaire');run('UPDATE stock_count_lines SET counted_quantity=?,note=? WHERE company_id=? AND count_id=? AND lot_id=?',integer(l.countedQuantity,0,1000000),clean(l.note,300),companyId,c.id,l.lotId);}audit(companyId,user.id,'STOCK_COUNT_SAVED','stock_count',c.id,{lines:data.items.length});});
  }else if(action==='submit'){
   if(c.state!=='COUNTING'||d.items.some(l=>l.counted_quantity===null))throw fail(409,'Comptez chaque lot avant de soumettre');tx(()=>{run("UPDATE stock_counts SET state='SUBMITTED',submitted_at=? WHERE id=? AND company_id=?",now(),c.id,companyId);audit(companyId,user.id,'STOCK_COUNT_SUBMITTED','stock_count',c.id);notify(ctx,{roles:['ADMIN','OPERATIONS']},'Inventaire à valider '+c.reference,'stock_count',c.id);});
  }else if(action==='apply'){
   if(c.state!=='SUBMITTED')throw fail(409,'Inventaire non soumis ou déjà appliqué');const note=clean(data.note,500);if(d.items.some(l=>l.counted_quantity!==l.expected_on_hand)&&note.length<5)throw fail(400,'Motif de régularisation requis');
   tx(()=>{const current=countLots(ctx,c);if(current.length!==d.items.length||current.some(l=>!d.items.some(x=>x.lot_id===l.id&&x.expected_on_hand===l.quantity_on_hand&&x.expected_reserved===l.quantity_reserved)))throw fail(409,'Stock modifié depuis l’ouverture : annulez cet inventaire et recommencez');
    if(d.items.some(l=>l.counted_quantity<l.expected_reserved))throw fail(409,'Le comptage ne couvre pas les réservations : vérifiez les commandes avant régularisation');
    for(const l of d.items){const lot=current.find(x=>x.id===l.lot_id);run('UPDATE stock_lots SET quantity_on_hand=? WHERE id=? AND company_id=?',l.counted_quantity,l.lot_id,companyId);stockMovement(ctx,{productId:lot.product_id,lotId:lot.id,kind:'COUNT',physical:l.counted_quantity-l.expected_on_hand,entityType:'stock_count',entityId:c.id,note,eventKey:'COUNT:'+c.id+':'+lot.id});}
    run("UPDATE stock_counts SET state='APPLIED',applied_by=?,applied_at=?,note=? WHERE id=? AND company_id=?",user.id,now(),note,c.id,companyId);audit(companyId,user.id,'STOCK_COUNT_APPLIED','stock_count',c.id,{note});if(c.merchant_id)notify(ctx,{merchant:c.merchant_id},'Inventaire régularisé '+c.reference,'stock_count',c.id);
   });
  }else if(action==='cancel'){
   if(!['COUNTING','SUBMITTED'].includes(c.state))throw fail(409,'Inventaire déjà clôturé');const note=clean(data.note,500);if(note.length<5)throw fail(400,'Motif requis');tx(()=>{run("UPDATE stock_counts SET state='CANCELLED',note=? WHERE id=? AND company_id=?",note,c.id,companyId);audit(companyId,user.id,'STOCK_COUNT_CANCELLED','stock_count',c.id,{note});});
  }else throw fail(404,'Action d’inventaire inconnue');return send(res,200,countDetail(ctx,c.id));
 }
 throw fail(404,'Route warehouse introuvable');
}
