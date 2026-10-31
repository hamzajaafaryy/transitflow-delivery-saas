import test from 'node:test';
import assert from 'node:assert/strict';
import {start,password} from './helpers.mjs';
const post=(t,path,data={},as='admin')=>t.request('/api/workflow'+path,{method:'POST',data,as});
const get=(t,path,as='admin')=>t.request('/api/workflow'+path,{as});
async function account(t,role,as,agencyId){const r=await t.request('/api/users',{method:'POST',data:{name:as,email:as+'@test.ma',password,role,agencyId}});assert.equal(r.status,201,JSON.stringify(r.value));assert.equal((await t.login(as+'@test.ma',as)).status,200);return r.value.id;}
async function prepareStock(t,mid,quantity=2){const p=await t.request('/api/inventory/products',{method:'POST',data:{sku:'ITEM-'+Math.random().toString(16).slice(2,8),name:'Article test',merchantId:mid}});await t.request('/api/inventory/receive',{method:'POST',data:{productId:p.value.id,quantity:10}});const s=await t.order({source:'STOCK',items:[{productId:p.value.id,quantity}]},'merchant');assert.equal(s.status,201,JSON.stringify(s.value));assert.equal((await t.pickup(s.value.tracking)).status,200);return {shipment:s.value,productId:p.value.id};}
async function sendToAgency(t,s){const d=await t.request('/api/dispatches',{method:'POST',data:{agencyId:t.agencies.Tanger.id,shipmentIds:[s.id]}});assert.equal(d.status,201,JSON.stringify(d.value));const route='/api/dispatches/'+d.value.dispatch.id;for(const [action,data] of [['scan',{scan:s.tracking}],['close',{}],['ship',{}]])assert.equal((await t.request(route+'/'+action,{method:'POST',data})).status,200);return d.value.dispatch.id;}
async function makeRoute(t,s,driverId,as='admin'){const r=await post(t,'/routes',{agencyId:t.agencies.Tanger.id,driverId,shipmentIds:[s.id]},as);assert.equal(r.status,201,JSON.stringify(r.value));assert.equal((await post(t,'/routes/'+r.value.id+'/start',{},as)).status,200);return r.value.id;}

test('merchant pickup request, assigned personal vehicle, partial collection and separate warehouse receipt',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),driver=await account(t,'PICKUP_DRIVER','pickup'),other=await account(t,'PICKUP_DRIVER','other');
  const v=await post(t,'/vehicles',{plate:'12345-A-6',kind:'CAR',ownership:'DRIVER',driverId:driver});assert.equal(v.status,201);
  const point=await post(t,'/pickup-points',{label:'Dépôt client',contactName:'Hamza',phone:'0611111111',city:'Casablanca',address:'Rue Marchand'},'merchant');assert.equal(point.status,201,JSON.stringify(point.value));
  const a=await t.order({},'merchant'),b=await t.order({},'merchant');
  const request=await post(t,'/pickups',{pointId:point.value.id,scheduledAt:new Date(Date.now()+3600000).toISOString(),shipmentIds:[a.value.id,b.value.id]},'merchant');assert.equal(request.status,201,JSON.stringify(request.value));
  assert.equal((await post(t,'/pickups',{pointId:point.value.id,scheduledAt:new Date().toISOString(),shipmentIds:[a.value.id]},'merchant')).status,409);
  assert.equal((await t.pickup(a.value.tracking)).status,409,'warehouse cannot accept a parcel not yet collected from the requested point');
  const url='/pickups/'+request.value.id;assert.equal((await post(t,url+'/assign',{driverId:driver,vehicleId:v.value.id})).status,200);
  assert.equal((await t.request('/api/stats',{as:'pickup'})).status,200);assert.equal((await t.request('/api/stats',{as:'other'})).value.total,0);assert.equal((await get(t,url,'other')).status,403);assert.equal((await post(t,url+'/start',{},'pickup')).status,200);
  assert.equal((await post(t,url+'/scan',{scan:a.value.tracking},'pickup')).status,200);assert.equal((await post(t,url+'/scan',{scan:a.value.tracking},'pickup')).status,409);
  assert.equal(t.db.prepare('SELECT status FROM shipments WHERE id=?').get(a.value.id).status,'COLLECTED');
  assert.equal((await post(t,url+'/complete',{receiverName:'Hamza'},'pickup')).status,400);
  assert.equal((await post(t,url+'/complete',{receiverName:'Hamza',note:'Deuxième colis pas prêt'},'pickup')).value.pickup.state,'PARTIAL');
  assert.equal((await post(t,url+'/cancel',{reason:'Trop tard pour annuler'},'merchant')).status,409);
  assert.equal((await t.pickup(a.value.tracking)).status,200);assert.equal((await get(t,url,'merchant')).value.pickup.state,'RECEIVED');
  const retry=await post(t,'/pickups',{pointId:point.value.id,scheduledAt:new Date().toISOString(),shipmentIds:[b.value.id]},'merchant');assert.equal(retry.status,201);
  assert.equal((await get(t,'/vehicles','pickup')).value.vehicles.length,1);assert.equal((await get(t,'/vehicles','other')).value.vehicles.length,0);
 }finally{await t.stop();}
});

test('arrival checks agency scope, delivery route proof, exact COD, cash discrepancy and reconciliation',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),driver=await account(t,'DRIVER','driver',t.agencies.Tanger.id),agent=await account(t,'AGENCY_AGENT','agent',t.agencies.Tanger.id);await account(t,'AGENCY_AGENT','foreign',t.agencies.Rabat.id);
  const s=await t.order({},'merchant');await t.pickup(s.value.tracking);const dispatchId=await sendToAgency(t,s.value);
  assert.equal((await post(t,'/arrivals/'+dispatchId+'/scan',{scan:s.value.tracking},'foreign')).status,403);
  const received=await post(t,'/arrivals/'+dispatchId+'/scan',{scan:s.value.tracking},'agent');assert.equal(received.status,200,JSON.stringify(received.value));assert.equal((await post(t,'/arrivals/'+dispatchId+'/scan',{scan:s.value.tracking},'agent')).status,409);
  assert.equal((await t.request('/api/shipments',{as:'foreign'})).value.shipments.length,0);
  const route=await makeRoute(t,s.value,driver);
  assert.equal((await post(t,'/routes/'+route+'/close',{},'driver')).status,409);
  assert.equal((await post(t,'/shipments/'+s.value.id+'/attempts',{result:'DELIVERED',receiverName:'Client',collectedAmount:100},'driver')).status,400);
  const attempt=await post(t,'/shipments/'+s.value.id+'/attempts',{result:'DELIVERED',receiverName:'Client',collectedAmount:200,requestId:'attempt-one'},'driver');assert.equal(attempt.status,201,JSON.stringify(attempt.value));
  assert.equal((await post(t,'/shipments/'+s.value.id+'/attempts',{result:'DELIVERED',receiverName:'Client',collectedAmount:200,requestId:'attempt-one'},'driver')).value.duplicate,true);
  assert.equal((await post(t,'/routes/'+route+'/close',{},'driver')).status,200);
  assert.equal((await t.request('/api/ledger/collect',{method:'POST',data:{shipmentId:s.value.id}})).status,409);
  const receipt=(await get(t,'/cash','driver')).value.receipts[0];assert.equal(receipt.state,'DECLARED');
  const remit=await post(t,'/cash/remittances',{receiptIds:[receipt.id],proofReference:'BORDEREAU-01'},'driver');assert.equal(remit.status,201);
  assert.equal((await post(t,'/cash/remittances/'+remit.value.id+'/reconcile',{receivedAmount:190,note:'Écart de dix dirhams'})).value.state,'DISPUTED');assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n,0);
  assert.equal((await post(t,'/cash/remittances/'+remit.value.id+'/reconcile',{receivedAmount:200,note:'Complément de caisse reçu'})).value.state,'RECONCILED');assert.equal(t.db.prepare('SELECT amount_centimes FROM ledger').get().amount_centimes,20000);
  assert.equal((await post(t,'/cash/remittances/'+remit.value.id+'/reconcile',{receivedAmount:200})).status,409);
 }finally{await t.stop();}
});

test('stock return requires physical receipt and inspection, restocks once and preserves merchant ownership',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),driver=await account(t,'DRIVER','driver',t.agencies.Tanger.id),{shipment:s,productId}=await prepareStock(t,mid);
  const dispatchId=await sendToAgency(t,s);await post(t,'/arrivals/'+dispatchId+'/scan',{scan:s.tracking});const route=await makeRoute(t,s,driver);assert.equal((await post(t,'/shipments/'+s.id+'/attempts',{result:'REFUSED',note:'Client refuse le colis'},'driver')).status,201);
  const ret=await post(t,'/returns',{shipmentId:s.id,reason:'Refus destinataire'},'merchant');assert.equal(ret.status,201,JSON.stringify(ret.value));const r='/returns/'+ret.value.id;
  assert.equal((await post(t,r+'/inspect',{disposition:'RESTOCK',note:'Contrôle prématuré'})).status,409);
  assert.equal((await post(t,r+'/authorize',{note:'Retour au warehouse validé'})).status,200);
  assert.equal((await post(t,r+'/ship',{proofReference:'BON-RETOUR-01'})).status,200);
  assert.equal((await post(t,r+'/receive',{scan:s.tracking,condition:'SEALED'})).status,200);
  assert.equal(t.db.prepare('SELECT SUM(quantity_on_hand) AS n FROM stock_lots WHERE product_id=?').get(productId).n,8);
  assert.equal((await post(t,r+'/inspect',{disposition:'RESTOCK',note:'Quantités et emballage validés'},'merchant')).status,403);
  assert.equal((await post(t,r+'/inspect',{disposition:'RESTOCK',note:'Quantités et emballage validés'})).status,200);
  assert.equal(t.db.prepare('SELECT SUM(quantity_on_hand) AS n FROM stock_lots WHERE product_id=?').get(productId).n,10);
  assert.equal((await post(t,r+'/inspect',{disposition:'RESTOCK',note:'Tentative double entrée'})).status,409);
  assert.equal((await post(t,r+'/complete',{})).status,200);assert.equal((await get(t,r,'merchant')).value.return.state,'COMPLETED');
  await t.merchant('Autre','other');assert.equal((await get(t,r,'other')).status,403);
 }finally{await t.stop();}
});

test('damaged returns never become sellable stock; reship creates a new tracking after inspection',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),{shipment:s,productId}=await prepareStock(t,mid);t.db.prepare("UPDATE shipments SET status='REFUSED' WHERE id=?").run(s.id);
  let ret=await post(t,'/returns',{shipmentId:s.id,reason:'Colis abîmé au transport'},'merchant'),r='/returns/'+ret.value.id;await post(t,r+'/authorize',{note:'Retour dommage accepté'});await post(t,r+'/ship',{proofReference:'RETOUR-DMG'});await post(t,r+'/receive',{scan:s.tracking,condition:'DAMAGED',note:'Emballage et produit endommagés'});
  assert.equal((await post(t,r+'/inspect',{disposition:'RESTOCK',note:'Ne pas ajouter de stock abîmé'})).status,409);
  assert.equal((await post(t,r+'/inspect',{disposition:'RETURN_MERCHANT',note:'Marchand informé des dégâts'})).status,200);assert.equal((await post(t,r+'/complete',{receiverName:'Marchand',proofReference:'REMISE-RETOUR'})).status,200);assert.equal(t.db.prepare('SELECT SUM(quantity_on_hand) AS n FROM stock_lots WHERE product_id=?').get(productId).n,8);
  const external=await t.order({},'merchant');await t.pickup(external.value.tracking);t.db.prepare("UPDATE shipments SET status='REFUSED' WHERE id=?").run(external.value.id);
  ret=await post(t,'/returns',{shipmentId:external.value.id,reason:'Client injoignable'},'merchant');r='/returns/'+ret.value.id;await post(t,r+'/authorize',{note:'Retour pour nouvel envoi'});await post(t,r+'/ship',{proofReference:'BON-RETOUR-2'});await post(t,r+'/receive',{scan:external.value.tracking,condition:'GOOD'});assert.equal((await post(t,r+'/inspect',{disposition:'RESTOCK',note:'Un colis externe ne crée aucun SKU'})).status,409);await post(t,r+'/inspect',{disposition:'RESHIP',note:'Colis conforme pour nouveau destinataire'});
  const child=await post(t,r+'/reexpedite',{order:{recipient:'Nouveau client',phone:'0622222222',city:'Rabat',address:'Rue Nouvelle',cod:150}},'merchant');assert.equal(child.status,201,JSON.stringify(child.value));assert.notEqual(child.value.child.tracking,external.value.tracking);assert.equal((await post(t,r+'/reexpedite',{order:{}},'merchant')).status,409);
 }finally{await t.stop();}
});

test('merchant claims, support conversation, private notes, attachment access, resolution and reopening',async()=>{
 const t=await start();try{
  await t.merchant();await t.merchant('Autre boutique','other');await account(t,'SUPPORT','support');
  const s=await t.order({},'merchant'),claim=await post(t,'/claims',{shipmentId:s.value.id,category:'DELAY',subject:'Livraison en retard',message:'Merci de vérifier mon colis'},'merchant');assert.equal(claim.status,201,JSON.stringify(claim.value));const c='/claims/'+claim.value.id;
  assert.equal((await get(t,c,'other')).status,403);
  assert.equal((await post(t,c+'/messages',{message:'Note interne confidentielle',internal:true},'support')).status,200);
  assert.equal((await get(t,c,'merchant')).value.messages.some(m=>m.internal),false);
  assert.equal((await post(t,c+'/messages',{message:'Le colis est pris en charge'},'support')).value.claim.state,'IN_PROGRESS');
  const pdf=Buffer.from('%PDF-1.4\nTest attachment\n%%EOF').toString('base64');assert.equal((await post(t,c+'/attachments',{filename:'preuve.pdf',mime:'application/pdf',base64:pdf},'merchant')).status,200);
  const attachment=(await get(t,c,'merchant')).value.attachments[0];assert.equal((await get(t,c+'/attachments/'+attachment.id,'other')).status,403);assert.equal((await get(t,c+'/attachments/'+attachment.id,'merchant')).status,200);
  assert.equal((await post(t,c+'/attachments',{filename:'unsafe.svg',mime:'image/svg+xml',base64:pdf},'merchant')).status,400);
  assert.equal((await post(t,c+'/update',{state:'RESOLVED',note:'Le colis est localisé au hub'},'support')).status,200);
  assert.equal((await post(t,c+'/update',{state:'CLOSED',note:'Merci pour le suivi'},'merchant')).status,200);
  assert.equal((await post(t,c+'/update',{state:'IN_PROGRESS',note:'Le problème persiste encore'},'merchant')).value.claim.state,'IN_PROGRESS');
  const notifications=await get(t,'/notifications','merchant');assert.ok(notifications.value.unread>0);await post(t,'/notifications/read',{},'merchant');assert.equal((await get(t,'/notifications','merchant')).value.unread,0);
 }finally{await t.stop();}
});

test('post-delivery returns preserve paid statements; refunds become a debit carried to a later payout',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),driver=await account(t,'DRIVER','driver',t.agencies.Tanger.id),{shipment:s}=await prepareStock(t,mid);const dispatchId=await sendToAgency(t,s);await post(t,'/arrivals/'+dispatchId+'/scan',{scan:s.tracking});const route=await makeRoute(t,s,driver);
  assert.equal((await post(t,'/shipments/'+s.id+'/attempts',{result:'DELIVERED',receiverName:'Client',collectedAmount:200},'driver')).status,201);await post(t,'/routes/'+route+'/close',{},'driver');
  const receipt=(await get(t,'/cash')).value.receipts[0],remit=await post(t,'/cash/remittances',{receiptIds:[receipt.id],proofReference:'REMISE-INITIAL'});await post(t,'/cash/remittances/'+remit.value.id+'/reconcile',{receivedAmount:200});
  const day=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10),previous=day(-1),today=day(0),future=day(1);
  t.db.prepare('UPDATE shipments SET delivered_at=? WHERE id=?').run(previous+'T12:00:00.000Z',s.id);
  await t.request('/api/finance/merchant-rates',{method:'POST',data:{merchantId:mid,city:'*',feeCentimes:3000}});
  const original=await t.request('/api/finance/merchant-statements',{method:'POST',data:{merchantId:mid,date:previous}});assert.equal(original.status,201,JSON.stringify(original.value));assert.equal(original.value.netCentimes,17000);await t.request('/api/finance/merchant-statements/'+original.value.id+'/confirm',{method:'POST',data:{}});await t.request('/api/finance/merchant-statements/'+original.value.id+'/mark-paid',{method:'POST',data:{paymentReference:'VIR-INITIAL'}});
  const ret=await post(t,'/returns',{shipmentId:s.id,reason:'Retour client après livraison'},'merchant'),r='/returns/'+ret.value.id;await post(t,r+'/authorize',{note:'Retour après vente accepté'});await post(t,r+'/ship',{proofReference:'RMA-APRÈS-VENTE'});await post(t,r+'/receive',{scan:s.tracking,condition:'GOOD'});await post(t,r+'/inspect',{disposition:'RESTOCK',note:'Produits conformes après contrôle'});await post(t,r+'/complete',{});
  assert.equal(t.db.prepare('SELECT status FROM shipments WHERE id=?').get(s.id).status,'DELIVERED');assert.equal(t.db.prepare('SELECT status FROM merchant_statements WHERE id=?').get(original.value.id).status,'PAID');
  const adjustment=await post(t,'/adjustments',{merchantId:mid,returnId:ret.value.id,kind:'REFUND',amount:-200,reference:'REMBOURSEMENT-001',note:'Remboursement client justifié après retour reçu'});assert.equal(adjustment.status,201,JSON.stringify(adjustment.value));
  assert.equal((await post(t,'/adjustments',{merchantId:mid,returnId:ret.value.id,kind:'REFUND',amount:-200,reference:'REMBOURSEMENT-002',note:'Tentative de remboursement en double'})).status,409);
  const debt=await t.request('/api/finance/merchant-statements',{method:'POST',data:{merchantId:mid,date:today}});assert.equal(debt.status,201,JSON.stringify(debt.value));assert.equal(debt.value.netCentimes,-20000);await t.request('/api/finance/merchant-statements/'+debt.value.id+'/confirm',{method:'POST',data:{}});assert.equal((await t.request('/api/finance/merchant-statements/'+debt.value.id+'/mark-paid',{method:'POST',data:{paymentReference:'INTERDIT-NEGATIF'}})).status,409);
  const next=await t.order({cod:300},'merchant');t.db.prepare("UPDATE shipments SET status='DELIVERED',delivered_at=? WHERE id=?").run(future+'T12:00:00.000Z',next.value.id);await t.request('/api/ledger/collect',{method:'POST',data:{shipmentId:next.value.id}});
  const offset=await t.request('/api/finance/merchant-statements',{method:'POST',data:{merchantId:mid,date:future}});assert.equal(offset.status,201,JSON.stringify(offset.value));assert.equal(offset.value.netCentimes,7000);
  assert.equal(t.db.prepare('SELECT carried_to_statement_id FROM merchant_statements WHERE id=?').get(debt.value.id).carried_to_statement_id,offset.value.id);
  assert.equal(t.db.prepare('SELECT net_centimes FROM merchant_statements WHERE id=?').get(original.value.id).net_centimes,17000);
 }finally{await t.stop();}
});

test('prepaid deliveries without COD still charge the contractual delivery fee as a debit',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),s=await t.order({cod:0},'merchant'),day=new Date().toISOString().slice(0,10);t.db.prepare("UPDATE shipments SET status='DELIVERED',delivered_at=? WHERE id=?").run(day+'T12:00:00.000Z',s.value.id);await t.request('/api/finance/merchant-rates',{method:'POST',data:{merchantId:mid,city:'*',feeCentimes:3000}});
  const st=await t.request('/api/finance/merchant-statements',{method:'POST',data:{merchantId:mid,date:day}});assert.equal(st.status,201,JSON.stringify(st.value));assert.equal(st.value.netCentimes,-3000);
 }finally{await t.stop();}
});

test('failure attempts require reasons and future appointments; responsible override is audited',async()=>{
 const t=await start();try{
  await t.merchant();const driver=await account(t,'DRIVER','driver',t.agencies.Tanger.id),s=await t.order({},'merchant');await t.pickup(s.value.tracking);const dispatchId=await sendToAgency(t,s.value);await post(t,'/arrivals/'+dispatchId+'/scan',{scan:s.value.tracking});const route=await makeRoute(t,s.value,driver);
  assert.equal((await post(t,'/shipments/'+s.value.id+'/attempts',{result:'POSTPONED',note:'Client demande un report'},'driver')).status,400);
  const nextAttemptAt=new Date(Date.now()+86400000).toISOString();assert.equal((await post(t,'/shipments/'+s.value.id+'/attempts',{result:'POSTPONED',note:'Client demande demain',nextAttemptAt},'driver')).status,201);await post(t,'/routes/'+route+'/close',{},'driver');
  assert.equal((await post(t,'/routes',{agencyId:t.agencies.Tanger.id,driverId:driver,shipmentIds:[s.value.id]})).status,409);
  const override=await post(t,'/routes',{agencyId:t.agencies.Tanger.id,driverId:driver,shipmentIds:[s.value.id],overrideReason:'Client rappelle pour une livraison immédiate'});assert.equal(override.status,201,JSON.stringify(override.value));
  const audit=t.db.prepare("SELECT details FROM audit_logs WHERE action='DELIVERY_ROUTE_CREATED' AND entity_id=?").get(override.value.id);assert.match(audit.details,/immédiate/);
 }finally{await t.stop();}
});

test('account roles enforce agency boundaries, warehouse/support separation and server-side logout revocation',async()=>{
 const t=await start();try{
  const warehouse=await account(t,'WAREHOUSE','warehouse'),support=await account(t,'SUPPORT','support'),agent=await account(t,'AGENCY_MANAGER','manager',t.agencies.Tanger.id);await account(t,'FINANCE','finance');await account(t,'DISPATCHER','dispatcher');
  assert.equal((await t.request('/api/inventory',{as:'warehouse'})).status,200);assert.equal((await get(t,'/cash','warehouse')).status,403);assert.equal((await t.request('/api/inventory/products',{method:'POST',as:'support',data:{sku:'FORBIDDEN',name:'No'}})).status,403);
  const own=await t.order(),other=await t.order({city:'Rabat'});assert.equal((await t.request('/api/shipments',{as:'manager'})).value.shipments.length,1);assert.equal((await t.request('/api/shipments/'+other.value.id,{as:'manager'})).status,403);assert.equal((await t.request('/api/dispatches',{as:'manager'})).status,200);assert.equal((await get(t,'/returns','finance')).status,200);
  const cookie=t.cookies.get('support');await t.request('/api/auth/logout',{method:'POST',as:'support',data:{}});assert.equal((await fetch(t.base+'/api/me',{headers:{Cookie:cookie}})).status,401);
  const blocked=await t.request('/api/users/'+warehouse,{method:'PATCH',data:{active:false}});assert.equal(blocked.status,200);assert.equal((await t.request('/api/me',{as:'warehouse'})).status,401);
  const me=(await t.request('/api/me')).value;assert.equal((await t.request('/api/users/'+me.user.id,{method:'PATCH',data:{active:false}})).status,409);
 }finally{await t.stop();}
});

test('partner cash retains the frozen agency fee; prepaid delivery produces a net payable to the agency',async()=>{
 const t=await start();try{
  await t.merchant();
  for(const [cod,expected] of [[200,180],[0,-20]]){
   const s=await t.order({cod},'merchant');await t.pickup(s.value.tracking);await sendToAgency(t,s.value);
   const delivered=await t.request('/api/integrations/status',{method:'POST',token:t.agencies.Tanger.apiKey,data:{eventId:'net-'+cod,tracking:s.value.tracking,status:'LIVRE'}});assert.equal(delivered.status,200,JSON.stringify(delivered.value));
   const receipt=(await get(t,'/cash')).value.receipts.find(r=>r.shipment_id===s.value.id);assert.equal(receipt.agency_fee_centimes,2000);assert.equal(receipt.amount_centimes,cod*100);
   const remit=await post(t,'/cash/remittances',{receiptIds:[receipt.id],proofReference:'NET-AGENCE-'+cod});assert.equal(remit.status,201,JSON.stringify(remit.value));assert.equal(remit.value.expectedCentimes,expected*100);
   assert.equal((await post(t,'/cash/remittances/'+remit.value.id+'/reconcile',{receivedAmount:expected,note:'Frais agence retenus selon contrat'})).value.state,'RECONCILED');
   const entry=t.db.prepare("SELECT amount_centimes FROM ledger WHERE shipment_id=? AND type='COD_COLLECTED'").get(s.value.id);assert.equal(entry?.amount_centimes??0,cod*100);
   assert.equal((await post(t,'/cash/remittances',{receiptIds:[receipt.id],proofReference:'REMISE-DOUBLE'})).status,409);
  }
 }finally{await t.stop();}
});

test('one active mission per vehicle and read-only support pickup access',async()=>{
 const t=await start();try{
  const mid=await t.merchant();await account(t,'SUPPORT','support');const driver=await account(t,'PICKUP_DRIVER','pickup');const vehicle=(await post(t,'/vehicles',{plate:'MISSION-1',kind:'CAR',ownership:'DRIVER',driverId:driver})).value.id;
  const point=(await post(t,'/pickup-points',{label:'Boutique',contactName:'Marchand',phone:'0612345678',city:'Casa',address:'Adresse boutique'},'merchant')).value.id;
  const ids=[];
  for(let n=0;n<2;n++){const s=await t.order({},'merchant'),p=await post(t,'/pickups',{pointId:point,scheduledAt:new Date().toISOString(),shipmentIds:[s.value.id]},'merchant');ids.push(p.value.id);await post(t,'/pickups/'+p.value.id+'/assign',{driverId:driver,vehicleId:vehicle});}
  assert.equal((await get(t,'/pickups/'+ids[0],'support')).status,200);assert.equal((await post(t,'/pickups/'+ids[0]+'/start',{},'support')).status,403);
  assert.equal((await post(t,'/pickups/'+ids[0]+'/start',{},'pickup')).status,200);assert.equal((await post(t,'/pickups/'+ids[1]+'/start',{},'pickup')).status,409);
 }finally{await t.stop();}
});

test('partner events cannot override an open return or move the original delivery date and duplicate COD',async()=>{
 const t=await start();try{
  await t.merchant();const s=await t.order({},'merchant');await t.pickup(s.value.tracking);await sendToAgency(t,s.value);
  const webhook=(eventId,status)=>t.request('/api/integrations/status',{method:'POST',token:t.agencies.Tanger.apiKey,data:{eventId,tracking:s.value.tracking,status}});
  const ret=await post(t,'/returns',{shipmentId:s.value.id,reason:'Retour demandé avant livraison'},'merchant');assert.equal(ret.status,201);
  assert.equal((await webhook('blocked','LIVRE')).status,409);await post(t,'/returns/'+ret.value.id+'/cancel',{reason:'Destinataire confirme le maintien de la commande'},'merchant');
  assert.equal((await webhook('first-delivery','LIVRE')).status,200);const date='2026-10-01T12:00:00.000Z';t.db.prepare('UPDATE shipments SET delivered_at=? WHERE id=?').run(date,s.value.id);
  assert.equal((await webhook('new-id-same-delivery','LIVRE')).status,200);assert.equal(t.db.prepare('SELECT delivered_at FROM shipments WHERE id=?').get(s.value.id).delivered_at,date);assert.equal(t.db.prepare('SELECT COUNT(*) n FROM cod_receipts WHERE shipment_id=?').get(s.value.id).n,1);
 }finally{await t.stop();}
});
