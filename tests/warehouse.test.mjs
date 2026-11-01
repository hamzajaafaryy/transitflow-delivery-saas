import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {start,password} from './helpers.mjs';
const key=()=>randomUUID();
const post=(t,path,data,as='admin')=>t.request('/api/workflow'+path,{method:'POST',data,as});
async function product(t,merchantId,extra={},as='merchant'){const r=await post(t,'/catalog',{sku:'SKU-01',name:'Produit',merchantId,barcode:'6001234567890',...extra},as);assert.equal(r.status,201,JSON.stringify(r.value));return r.value.id;}
async function role(t,role,name=role.toLowerCase()){const email=name+'@example.ma',r=await t.request('/api/users',{method:'POST',data:{name,email,password,role}});assert.equal(r.status,201);assert.equal((await t.login(email,name)).status,200);return r.value.id;}
async function intake(t,merchantId,productId,extra={}){const r=await post(t,'/stock-intakes',{merchantId,expectedBoxes:2,items:[{productId,quantity:10}],...extra},'merchant');assert.equal(r.status,201,JSON.stringify(r.value));return r.value;}
function receipt(d,extra={}){return {requestId:key(),boxes:1,receiverName:'Magasinier Atlas',proofReference:'BL-ENT-001',items:[{lineId:d.items[0].id,acceptedQuantity:7,damagedQuantity:2,location:'A-01'}],...extra};}

test('merchant catalog separates identical SKUs and barcodes; creation cannot impersonate another merchant',async()=>{
 const t=await start();try{
  const m=await t.merchant(),other=await t.merchant('Autre','other'),p=await product(t,m);
  assert.equal((await post(t,'/catalog',{sku:'NEW',name:'Nouveau',merchantId:other},'merchant')).status,403);
  assert.equal((await post(t,'/catalog',{sku:'SKU-01',name:'Dupliqué'},'merchant')).status,409);
  assert.equal((await post(t,'/catalog',{sku:'OTHER',name:'Dupliqué',barcode:'sku-01'},'merchant')).status,409);
  assert.equal((await post(t,'/catalog',{sku:'SKU-01',name:'Autre propriétaire',barcode:'6001234567890'},'other')).status,201);
  assert.equal((await t.request('/api/workflow/catalog?merchantId='+other,{as:'merchant'})).value.products.length,1);
  assert.equal((await t.request('/api/workflow/catalog',{as:'merchant'})).value.products[0].id,p);
  assert.equal((await post(t,'/catalog',{sku:'INVALID?',name:'Invalid'},'merchant')).status,400);
  await role(t,'DRIVER');assert.equal((await t.request('/api/workflow/catalog',{as:'driver'})).status,403);
 }finally{await t.stop();}
});

test('stock intake receives partial cartons, isolates damage, records discrepancies and safely retries receipts',async()=>{
 const t=await start();try{
  const m=await t.merchant(),p=await product(t,m),d=await intake(t,m,p),path='/stock-intakes/'+d.intake.id;
  await role(t,'WAREHOUSE');await role(t,'SUPPORT');await t.merchant('Autre','other');
  assert.equal((await t.request('/api/workflow'+path,{as:'other'})).status,404);
  assert.equal((await post(t,path+'/receive',receipt(d),'merchant')).status,403);
  assert.equal((await post(t,path+'/receive',receipt(d),'support')).status,403);
  const data=receipt(d),received=await post(t,path+'/receive',data,'warehouse');assert.equal(received.status,201,JSON.stringify(received.value));assert.equal(received.value.intake.state,'PARTIAL');assert.equal(received.value.summary.accepted,7);assert.equal(received.value.summary.damaged,2);assert.equal(received.value.summary.missing,1);
  assert.equal((await post(t,path+'/receive',data,'warehouse')).value.duplicate,true);
  assert.equal((await post(t,path+'/receive',{...data,boxes:2},'warehouse')).status,409);
  const stock=(await t.request('/api/merchant/stock',{as:'merchant'})).value;assert.equal(stock.summary.unitsAvailable,7);assert.equal(stock.summary.unitsQuarantined,2);
  assert.equal((await post(t,path+'/close',{},'warehouse')).status,400);
  assert.equal((await post(t,path+'/receive',receipt(d,{items:[{lineId:d.items[0].id,acceptedQuantity:2}]}),'warehouse')).status,400,'surplus needs reason');
  const tail=receipt(d,{proofReference:'BL-ENT-002',items:[{lineId:d.items[0].id,acceptedQuantity:1}]});assert.equal((await post(t,path+'/receive',tail,'warehouse')).status,201);
  assert.equal((await post(t,path+'/close',{note:'Deux unités endommagées isolées en quarantaine'},'warehouse')).status,200);
  assert.equal((await post(t,path+'/close',{note:'Une seconde clôture'},'warehouse')).status,409);
  assert.equal((await post(t,path+'/receive',tail,'warehouse')).value.duplicate,true,'lost successful response may be retried after close');
  assert.equal((await post(t,path+'/receive',receipt(d),'warehouse')).status,409);
  const print=await t.request('/api/workflow'+path+'/print',{as:'merchant'});assert.equal(print.status,200);assert.match(print.value,/BL-ENT-002/);assert.match(print.value,/Quarantaine/);
  const ledger=(await t.request('/api/workflow/stock-movements',{as:'merchant'})).value.movements;assert.equal(ledger.reduce((n,l)=>n+l.physical_delta,0),8);assert.equal(ledger.reduce((n,l)=>n+l.quarantine_delta,0),2);assert.equal(ledger.length,3);
  assert.throws(()=>t.db.prepare("UPDATE stock_movements SET note='erase'").run(),/immutable/);assert.throws(()=>t.db.prepare('DELETE FROM stock_movements').run(),/immutable/);
 }finally{await t.stop();}
});

test('stock supply collection uses assigned driver and vehicle; warehouse reception is a distinct physical step',async()=>{
 const t=await start();try{
  const m=await t.merchant(),p=await product(t,m),driver=await role(t,'PICKUP_DRIVER'),other=await role(t,'PICKUP_DRIVER','otherdriver');await role(t,'DISPATCHER');
  const vehicle=await t.request('/api/workflow/vehicles',{method:'POST',data:{plate:'SUP-001',ownership:'DRIVER',driverId:driver}}),point=await post(t,'/pickup-points',{label:'Boutique',contactName:'Contact',phone:'0612345678',city:'Casablanca',address:'Rue 1'},'merchant');
  const d=await intake(t,m,p,{mode:'COLLECTION',pointId:point.value.id,scheduledAt:'2026-12-02T10:00:00Z'}),path='/stock-intakes/'+d.intake.id;
  assert.equal((await post(t,path+'/receive',receipt(d))).status,409);
  assert.equal((await post(t,path+'/assign',{driverId:other,vehicleId:vehicle.value.id},'dispatcher')).status,400);
  assert.equal((await post(t,path+'/assign',{driverId:driver,vehicleId:vehicle.value.id},'dispatcher')).status,200);
  assert.equal((await post(t,path+'/start',{},'otherdriver')).status,404);assert.equal((await post(t,path+'/start',{},'pickup_driver')).status,200);
  // A parcel pickup cannot start while the same personal vehicle collects stock.
  const parcel=await t.order({},'merchant'),pick=await post(t,'/pickups',{pointId:point.value.id,scheduledAt:'2026-12-02T10:00:00Z',shipmentIds:[parcel.value.id]},'merchant');
  await post(t,'/pickups/'+pick.value.id+'/assign',{driverId:driver,vehicleId:vehicle.value.id});assert.equal((await post(t,'/pickups/'+pick.value.id+'/start',{},'pickup_driver')).status,409);
  assert.equal((await post(t,path+'/collect',{boxes:1,senderName:'Client',proofReference:'PICK-01'},'pickup_driver')).status,400);
  assert.equal((await post(t,path+'/collect',{boxes:1,senderName:'Client',proofReference:'PICK-01',note:'Un carton non prêt chez le client'},'pickup_driver')).status,200);
  assert.equal((await t.request('/api/merchant/stock',{as:'merchant'})).value.summary.unitsPhysical,0,'collection creates no warehouse stock');
  assert.equal((await post(t,'/pickups/'+pick.value.id+'/start',{},'pickup_driver')).status,200,'vehicle freed after physical collection');
  assert.equal((await post(t,path+'/receive',receipt(d))).status,201);
  assert.equal((await t.request('/api/workflow/stock-intakes',{as:'pickup_driver'})).value.intakes.length,1);
 }finally{await t.stop();}
});

test('product picking rejects wrong and excess scans and blocks stock departure until all quantities match',async()=>{
 const t=await start();try{
  const m=await t.merchant(),p=await product(t,m),p2=await product(t,m,{sku:'SKU-02',barcode:'6009999'});for(const productId of [p,p2])await t.request('/api/inventory/receive',{method:'POST',data:{productId,quantity:10}});
  const s=await t.order({source:'STOCK',items:[{productId:p,quantity:3},{productId:p2,quantity:1}]},'merchant'),path='/picking/'+s.value.id;
  assert.equal((await t.request('/api/operations/ramassage',{method:'POST',data:{scan:s.value.tracking}})).status,409);
  assert.equal((await post(t,path+'/scan',{productScan:'WRONG-SKU',requestId:key()})).status,409);
  assert.equal((await post(t,path+'/scan',{productScan:'SKU-01',quantity:4,requestId:key()})).status,409);
  const scan={productScan:'6001234567890',quantity:3,requestId:key()};assert.equal((await post(t,path+'/scan',scan)).status,201);assert.equal((await post(t,path+'/scan',scan)).value.duplicate,true);
  assert.equal((await post(t,path+'/scan',{...scan,quantity:1})).status,409);assert.equal((await post(t,path+'/scan',{productScan:p2,quantity:1,requestId:key()},'merchant')).status,403);
  assert.equal((await t.request('/api/operations/ramassage',{method:'POST',data:{scan:s.value.id}})).status,409);
  assert.equal((await post(t,path+'/scan',{productScan:'SKU-02',quantity:1,requestId:key()})).value.complete,true);
  assert.equal((await t.request('/api/operations/ramassage',{method:'POST',data:{scan:s.value.id}})).status,200);assert.equal((await t.request('/api/operations/ramassage',{method:'POST',data:{scan:s.value.id}})).value.duplicate,true);
  assert.equal((await post(t,path+'/scan',{productScan:p,requestId:key()})).status,409);
  let ledger=(await t.request('/api/workflow/stock-movements?productId='+p,{as:'merchant'})).value.movements;assert.equal(ledger.reduce((n,l)=>n+l.physical_delta,0),7);assert.equal(ledger.reduce((n,l)=>n+l.reserved_delta,0),0);
  const cancel=await t.order({source:'STOCK',items:[{productId:p,quantity:2}]},'merchant');await t.request('/api/shipments/'+cancel.value.id+'/status',{method:'POST',data:{status:'CANCELLED',note:'Annulation avant préparation'}});
  ledger=(await t.request('/api/workflow/stock-movements?productId='+p,{as:'merchant'})).value.movements;assert.ok(ledger.some(l=>l.kind==='RELEASE'));assert.equal(ledger.reduce((n,l)=>n+l.reserved_delta,0),0);
 }finally{await t.stop();}
});

test('physical count needs complete counts, authorized approval and unchanged stock; adjustments are atomic and logged',async()=>{
 const t=await start();try{
  const m=await t.merchant(),p=await product(t,m);await role(t,'WAREHOUSE');await role(t,'OPERATIONS');await t.request('/api/inventory/receive',{method:'POST',data:{productId:p,quantity:10,location:'A-01'}});
  let d=(await post(t,'/stock-counts',{merchantId:m},'warehouse')).value,path='/stock-counts/'+d.count.id;
  assert.equal((await post(t,path+'/lines',{items:[null]},'warehouse')).status,400);
  assert.equal((await post(t,path+'/submit',{},'warehouse')).status,409);
  assert.equal((await post(t,path+'/lines',{items:[{lotId:d.items[0].lot_id,countedQuantity:8}]},'warehouse')).status,200);
  assert.equal((await post(t,path+'/submit',{},'warehouse')).status,200);assert.equal((await post(t,path+'/apply',{note:'Deux unités manquantes'},'warehouse')).status,403);assert.equal((await post(t,path+'/apply',{},'operations')).status,400);
  assert.equal((await post(t,path+'/apply',{note:'Deux unités manquantes, comptage confirmé'},'operations')).status,200);assert.equal((await post(t,path+'/apply',{note:'Rejouer'},'operations')).status,409);
  assert.equal((await t.request('/api/merchant/stock',{as:'merchant'})).value.summary.unitsPhysical,8);
  const ledger=(await t.request('/api/workflow/stock-movements',{as:'merchant'})).value.movements;assert.equal(ledger.reduce((n,l)=>n+l.physical_delta,0),8);assert.equal(ledger[0].kind,'COUNT');
  d=(await post(t,'/stock-counts',{merchantId:m})).value;path='/stock-counts/'+d.count.id;await post(t,path+'/lines',{items:d.items.map(l=>({lotId:l.lot_id,countedQuantity:7}))});await post(t,path+'/submit',{});
  await t.order({source:'STOCK',items:[{productId:p,quantity:1}]},'merchant');assert.equal((await post(t,path+'/apply',{note:'Unité manquante'})).status,409,'reservations changed');assert.equal((await t.request('/api/merchant/stock',{as:'merchant'})).value.summary.unitsPhysical,8);
  assert.equal((await post(t,path+'/cancel',{note:'Recommencer après réservation'})).status,200);
  d=(await post(t,'/stock-counts',{merchantId:m})).value;path='/stock-counts/'+d.count.id;await post(t,path+'/lines',{items:d.items.map(l=>({lotId:l.lot_id,countedQuantity:0}))});await post(t,path+'/submit',{});assert.equal((await post(t,path+'/apply',{note:'Stock physiquement introuvable'})).status,409,'cannot break reservations');
  assert.equal((await post(t,'/stock-counts',{merchantId:m},'merchant')).status,403);
 }finally{await t.stop();}
});

test('inventory snapshots reject newly received lots, and receipt validation rolls back all products on a bad line',async()=>{
 const t=await start();try{
  const m=await t.merchant(),p=await product(t,m),d=await intake(t,m,p),path='/stock-intakes/'+d.intake.id;
  const bad=receipt(d,{items:[...receipt(d).items,{lineId:key(),acceptedQuantity:1}]});assert.equal((await post(t,path+'/receive',bad)).status,400);assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM stock_lots').get().n,0);assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,0);assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM stock_intake_receipts').get().n,0);
  const r=await post(t,path+'/receive',receipt(d,{items:[{lineId:d.items[0].id,acceptedQuantity:5}]}));assert.equal(r.status,201);
  const count=(await post(t,'/stock-counts',{merchantId:m})).value,cp='/stock-counts/'+count.count.id;
  await post(t,cp+'/lines',{items:count.items.map(l=>({lotId:l.lot_id,countedQuantity:4}))});await post(t,cp+'/submit',{});
  await t.request('/api/inventory/receive',{method:'POST',data:{productId:p,quantity:3}});assert.equal((await post(t,cp+'/apply',{note:'Correction physique à rejeter'})).status,409);assert.equal((await t.request('/api/merchant/stock',{as:'merchant'})).value.summary.unitsPhysical,8);
  await t.merchant('Autre','other');assert.equal((await t.request('/api/workflow'+cp,{as:'other'})).status,404);
  assert.equal((await t.request('/api/workflow/stock-movements?limit=1&offset=1',{as:'merchant'})).value.movements.length,1);
 }finally{await t.stop();}
});

test('quarantine dispositions require responsible approval and proof, never exceed their balance and retry safely',async()=>{
 const t=await start();try{
  const m=await t.merchant(),p=await product(t,m),d=await intake(t,m,p);await post(t,'/stock-intakes/'+d.intake.id+'/receive',receipt(d));await role(t,'WAREHOUSE');await t.merchant('Autre','other');
  const q=(await t.request('/api/workflow/quarantine',{as:'merchant'})).value.quarantine[0],path='/quarantine/'+q.id+'/dispose';assert.equal(q.quantity_remaining,2);assert.equal((await t.request('/api/workflow/quarantine',{as:'other'})).value.quarantine.length,0);
  const data={requestId:key(),kind:'RELEASE',quantity:1,note:'Contrôle contradictoire, unité finalement conforme',proofReference:'QC-002',location:'A-02'};
  assert.equal((await post(t,path,data,'warehouse')).status,403);assert.equal((await post(t,path,data,'merchant')).status,403);assert.equal((await post(t,path,data)).status,201);assert.equal((await post(t,path,data)).value.duplicate,true);
  assert.equal((await post(t,path,{...data,requestId:key(),quantity:2})).status,409);
  assert.equal((await post(t,path,{...data,requestId:key(),kind:'RETURN'})).status,400);
  assert.equal((await post(t,path,{...data,requestId:key(),kind:'RETURN',receiverName:'Marchand Atlas',proofReference:'REMISE-005'})).status,201);
  const stock=(await t.request('/api/merchant/stock',{as:'merchant'})).value;assert.equal(stock.summary.unitsAvailable,8);assert.equal(stock.summary.unitsQuarantined,0);
  const ledger=(await t.request('/api/workflow/stock-movements',{as:'merchant'})).value.movements;assert.equal(ledger.reduce((n,l)=>n+l.physical_delta,0),8);assert.equal(ledger.reduce((n,l)=>n+l.quarantine_delta,0),0);
 }finally{await t.stop();}
});
