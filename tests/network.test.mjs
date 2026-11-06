import test from 'node:test';
import assert from 'node:assert/strict';
import {start,password} from './helpers.mjs';
import {networkSchema} from '../src/network-schema.mjs';
const post=(t,path,data={},as='admin')=>t.request('/api'+path,{method:'POST',data,as});
const wf=(t,path,data={},as='admin')=>post(t,'/workflow'+path,data,as);
const get=(t,path,as='admin')=>t.request('/api/workflow'+path,{as});
const row=(t,s)=>t.db.prepare('SELECT * FROM shipments WHERE id=?').get(s.id);
async function account(t,role,name,agencyId){const r=await post(t,'/users',{name,email:name+'@network.ma',password,role,agencyId});assert.equal(r.status,201,JSON.stringify(r.value));assert.equal((await t.login(name+'@network.ma',name)).status,200);return r.value.id;}
async function stock(t,mid){const r=await post(t,'/inventory/products',{merchantId:mid,sku:'CREAM',name:'Crème 30ml'});assert.equal(r.status,201);assert.equal((await post(t,'/inventory/receive',{productId:r.value.id,quantity:10})).status,201);return r.value.id;}
const units=(t,productId)=>t.db.prepare('SELECT SUM(quantity_on_hand) AS n FROM stock_lots WHERE product_id=?').get(productId).n;
async function labels(t,shipments,as='admin'){const result=await post(t,'/labels',{shipmentIds:shipments.map(s=>s.id)},as);assert.equal(result.status,201,JSON.stringify(result.value));return result.value;}
async function send(t,shipments,city='Tanger'){
 for(const s of shipments)assert.equal((await t.pickup(s.tracking)).status,200);
 const d=await post(t,'/dispatches',{agencyId:t.agencies[city].id,shipmentIds:shipments.map(s=>s.id)});assert.equal(d.status,201,JSON.stringify(d.value));const path='/dispatches/'+d.value.dispatch.id;
 for(const s of shipments)assert.equal((await post(t,path+'/scan',{scan:s.tracking})).status,200);
 assert.equal((await post(t,path+'/close')).status,200);assert.equal((await post(t,path+'/ship')).status,200);
 for(const s of shipments)assert.equal((await wf(t,'/arrivals/'+d.value.dispatch.id+'/scan',{scan:s.tracking})).status,200);
 return d.value.dispatch.id;
}
async function cancel(t,s){const result=await post(t,'/shipments/'+s.id+'/status',{status:'CANCELLED',note:'Annulation confirmée par le destinataire'});assert.equal(result.status,200,JSON.stringify(result.value));}
async function pack(t,shipments,{city='Tanger',as='admin',expected=true}={}){
 const result=await wf(t,'/return-containers',{agencyId:t.agencies[city].id,...expected?{shipmentIds:shipments.map(s=>s.id)}:{}},as);assert.equal(result.status,201,JSON.stringify(result.value));const path='/return-containers/'+result.value.container.id;
 for(const s of shipments)assert.equal((await wf(t,path+'/scan',{scan:s.tracking},as)).status,200);
 assert.equal((await wf(t,path+'/close',{},as)).status,200);assert.equal((await wf(t,path+'/ship',{proofReference:'SCELLE-TRANSFERT-01'},as)).status,200);return path;
}

test('100 × 100 merchant label batches separate pickup/stock and owners; preparation is atomic and reprints preserve progress',async()=>{
 const t=await start();try{
  const mid=await t.merchant('Premier','first'),other=await t.merchant('Second','second'),pid=await stock(t,mid);
  const a=(await t.order({},'first')).value,b=(await t.order({},'first')).value,c=(await t.order({source:'STOCK',items:[{productId:pid,quantity:2}]},'first')).value,d=(await t.order({},'second')).value;
  const raw=await t.request('/api/shipments/'+a.id+'/ticket',{as:'first'});assert.equal(raw.status,200);assert.equal(row(t,a).status,'CREATED','a read-only preview never marks a label printed');
  assert.equal((await post(t,'/labels',{shipmentIds:[a.id,c.id]},'first')).status,409);assert.equal(row(t,a).labels_printed_at,null);
  assert.equal((await post(t,'/labels',{shipmentIds:[a.id,d.id]})).status,409);assert.equal((await post(t,'/labels',{shipmentIds:[d.id]},'first')).status,403);
  const batch=await labels(t,[a,b],'first');assert.equal(row(t,a).status,'AWAITING_PICKUP');assert.equal(row(t,c).status,'CREATED');assert.equal(units(t,pid),10);
  const page=await t.request(batch.printUrl,{as:'first'});assert.equal(page.status,200);assert.match(page.value,/size:100mm 100mm/);assert.equal((page.value.match(/class="ticket"/g)||[]).length,2);assert.match(page.value,/COMMANDE RAMASSAGE/);assert.ok(!page.value.includes(c.tracking));
  assert.equal((await t.request(batch.printUrl,{as:'second'})).status,403);assert.equal((await t.request(batch.printUrl,{as:'guest'})).status,401);
  const list=await t.request('/api/labels?source=STOCK',{as:'first'});assert.equal(list.value.total,1);assert.equal(list.value.shipments[0].id,c.id);
  assert.equal((await t.pickup(a.tracking)).status,200);await labels(t,[a],'first');assert.equal(row(t,a).status,'PICKED_UP');assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND status='AWAITING_PICKUP'").get(a.id).n,1);
  await labels(t,[c],'first');assert.equal(row(t,c).status,'AWAITING_PICKUP');assert.equal((await t.pickup(c.tracking)).status,200);assert.equal(units(t,pid),8);
 }finally{await t.stop();}
});

test('each scan advances only its parcel: collection, city shipment, city arrival, and delivery handover',async()=>{
 const t=await start();try{
  await t.merchant();const driver=await account(t,'DRIVER','driver',t.agencies.Tanger.id);await account(t,'AGENCY_MANAGER','tanger',t.agencies.Tanger.id);await account(t,'AGENCY_MANAGER','rabat',t.agencies.Rabat.id);
  const a=(await t.order({},'merchant')).value,b=(await t.order({},'merchant')).value;await labels(t,[a,b],'merchant');assert.equal((await t.pickup(a.tracking)).status,200);assert.equal(row(t,a).status,'PICKED_UP');assert.equal(row(t,b).status,'AWAITING_PICKUP');await t.pickup(b.tracking);
  const d=(await post(t,'/dispatches',{agencyId:t.agencies.Tanger.id,shipmentIds:[a.id,b.id]})).value.dispatch,path='/dispatches/'+d.id;
  await post(t,path+'/scan',{scan:a.tracking});assert.equal(row(t,a).status,'IN_TRANSIT');assert.equal(row(t,b).status,'PICKED_UP');assert.equal((await get(t,'/agency-parcels')).value.total,0);
  await post(t,path+'/scan',{scan:b.tracking});await post(t,path+'/close');await post(t,path+'/ship');await wf(t,'/arrivals/'+d.id+'/scan',{scan:a.tracking},'tanger');await wf(t,'/arrivals/'+d.id+'/scan',{scan:b.tracking},'tanger');assert.equal(row(t,a).status,'AT_AGENCY');assert.equal((await get(t,'/agency-parcels','rabat')).value.total,0);assert.equal((await get(t,'/agency-parcels','tanger')).value.total,2);
  const tour=await wf(t,'/routes',{agencyId:t.agencies.Tanger.id,driverId:driver,shipmentIds:[a.id,b.id]},'tanger');assert.equal(tour.status,201);const route='/routes/'+tour.value.id;
  assert.equal((await wf(t,route+'/start',{},'driver')).status,409);assert.equal((await wf(t,route+'/scan',{scan:a.tracking},'rabat')).status,403);
  assert.equal((await wf(t,route+'/scan',{scan:a.tracking},'tanger')).status,200);assert.equal(row(t,a).status,'OUT_FOR_DELIVERY');assert.equal(row(t,b).status,'AT_AGENCY');assert.equal((await wf(t,route+'/scan',{scan:a.tracking},'driver')).value.duplicate,true);assert.equal((await wf(t,route+'/start',{},'driver')).status,409);
  await wf(t,route+'/scan',{scan:b.tracking},'driver');assert.equal((await wf(t,route+'/start',{},'driver')).status,200);assert.equal(row(t,a).custody_type,'DRIVER');assert.equal((await wf(t,'/shipments/'+a.id+'/attempts',{result:'REFUSED',note:'Refus confirmé par le client'},'driver')).status,201);assert.equal((await wf(t,'/shipments/'+b.id+'/attempts',{result:'CANCELLED',note:'Client annule sa commande'},'driver')).status,201);
  assert.equal((await get(t,'/return-containers','tanger')).value.total,2);
 }finally{await t.stop();}
});

test('mixed city returns restock only their owner’s warehouse products once; pickup parcels require merchant scan and proof',async()=>{
 const t=await start();try{
  const mid=await t.merchant('Premier','first');await t.merchant('Second','second');const pid=await stock(t,mid),a=(await t.order({source:'STOCK',items:[{productId:pid,quantity:2}]},'first')).value,b=(await t.order({},'first')).value,foreign=(await t.order({},'second')).value;
  await account(t,'AGENCY_MANAGER','tanger',t.agencies.Tanger.id);await account(t,'AGENCY_MANAGER','rabat',t.agencies.Rabat.id);await send(t,[a,b,foreign]);for(const s of [a,b,foreign])await cancel(t,s);assert.equal(row(t,b).custody_type,'AGENCY');assert.equal(units(t,pid),8);
  const d=await wf(t,'/return-containers',{agencyId:t.agencies.Tanger.id,shipmentIds:[a.id,b.id]},'tanger'),path='/return-containers/'+d.value.container.id;
  assert.equal((await wf(t,path+'/scan',{scan:a.tracking},'rabat')).status,403);await wf(t,path+'/scan',{scan:a.tracking},'tanger');assert.equal((await wf(t,path+'/close',{},'tanger')).status,409);assert.equal((await wf(t,path+'/scan',{scan:a.tracking},'tanger')).value.duplicate,true);await wf(t,path+'/scan',{scan:b.tracking},'tanger');await wf(t,path+'/close',{},'tanger');assert.equal((await wf(t,path+'/ship',{},'tanger')).status,400);await wf(t,path+'/ship',{proofReference:'BON-50-001'},'tanger');
  assert.equal((await wf(t,path+'/receive-scan',{scan:a.tracking,condition:'GOOD'},'tanger')).status,403);assert.equal((await wf(t,path+'/receive-scan',{scan:foreign.tracking,condition:'GOOD'})).status,409);assert.equal((await wf(t,path+'/receive-scan',{scan:a.tracking})).status,400);assert.equal(units(t,pid),8);
  let received=await wf(t,path+'/receive-scan',{scan:a.tracking,condition:'SEALED'});assert.equal(received.status,200,JSON.stringify(received.value));assert.equal(units(t,pid),10);assert.equal(received.value.summary.notReceived,1);assert.equal(row(t,a).status,'RETURNED');assert.equal((await get(t,'/return-containers')).value.total,2);
  assert.equal((await wf(t,path+'/receive-scan',{scan:a.tracking,condition:'SEALED'})).value.duplicate,true);assert.equal(units(t,pid),10);
  received=await wf(t,path+'/receive-scan',{scan:b.tracking,condition:'GOOD'});assert.equal(received.status,200,JSON.stringify(received.value));assert.equal(received.value.container.state,'RECEIVED');assert.equal(units(t,pid),10);assert.equal(row(t,b).custody_type,'WAREHOUSE');assert.equal(t.db.prepare('SELECT disposition FROM parcel_returns WHERE shipment_id=?').get(b.id).disposition,'RETURN_MERCHANT');
  assert.equal((await get(t,'/merchant-returns','first')).value.items.length,1);assert.equal((await get(t,'/merchant-returns','second')).value.items.length,0);
  const bon=(await wf(t,'/merchant-returns',{merchantId:mid,shipmentIds:[b.id]})).value.bon,bpath='/merchant-returns/'+bon.id;
  assert.equal((await get(t,bpath,'second')).status,403);assert.equal((await wf(t,bpath+'/scan',{scan:b.tracking},'first')).status,403);assert.equal((await wf(t,bpath+'/complete',{receiverName:'Premier',proofReference:'REMISE'})).status,409);assert.equal((await wf(t,bpath+'/scan',{scan:foreign.tracking})).status,409);assert.equal((await wf(t,bpath+'/scan',{scan:b.tracking})).status,200);assert.equal((await wf(t,bpath+'/complete',{receiverName:'Premier'})).status,400);assert.equal((await wf(t,bpath+'/complete',{receiverName:'Premier',proofReference:'SIGNATURE-01'})).status,200);assert.equal(row(t,b).status,'RETURNED_MERCHANT');assert.equal(row(t,b).custody_type,'MERCHANT');assert.equal(units(t,pid),10);assert.equal((await get(t,'/merchant-returns','first')).value.items.length,0);assert.equal((await wf(t,bpath+'/complete',{receiverName:'Premier',proofReference:'SIGNATURE-01'})).status,409);
 }finally{await t.stop();}
});

test('damaged city stock return is received but remains unsellable until manual inspection',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),pid=await stock(t,mid),s=(await t.order({source:'STOCK',items:[{productId:pid,quantity:2}]},'merchant')).value;await send(t,[s]);await cancel(t,s);const path=await pack(t,[s]);
  assert.equal((await wf(t,path+'/receive-scan',{scan:s.tracking,condition:'DAMAGED'})).status,400);assert.equal(row(t,s).custody_type,'RETURN_TRANSIT');assert.equal(units(t,pid),8);
  const received=await wf(t,path+'/receive-scan',{scan:s.tracking,condition:'DAMAGED',note:'Flacon cassé dans le colis'});assert.equal(received.status,200,JSON.stringify(received.value));assert.equal(received.value.container.state,'RECEIVED');assert.equal(units(t,pid),8);const r=t.db.prepare('SELECT * FROM parcel_returns WHERE shipment_id=?').get(s.id);assert.equal(r.state,'RECEIVED');assert.equal(r.disposition,null);assert.equal((await wf(t,'/returns/'+r.id+'/inspect',{disposition:'RESTOCK',note:'Essai de stock endommagé'})).status,409);
 }finally{await t.stop();}
});

test('cancelling an uncollected order releases reservations without creating a physical return; cancelling city orders preserves their location',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),pid=await stock(t,mid),a=(await t.order({source:'STOCK',items:[{productId:pid,quantity:2}]},'merchant')).value;await labels(t,[a]);await cancel(t,a);assert.equal(units(t,pid),10);assert.equal(t.db.prepare('SELECT SUM(quantity_reserved) AS n FROM stock_lots').get().n,0);assert.equal((await get(t,'/return-containers')).value.total,0);
  const b=(await t.order({},'merchant')).value;await send(t,[b]);await cancel(t,b);assert.equal(row(t,b).custody_agency_id,t.agencies.Tanger.id);assert.equal((await get(t,'/return-containers')).value.cities[0].to_pack,1);
  assert.equal((await wf(t,'/return-containers',{agencyId:t.agencies.Rabat.id,shipmentIds:[b.id]})).status,409);assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM return_containers').get().n,0,'invalid containers roll back atomically');
 }finally{await t.stop();}
});

test('cancelled outbound and return containers restore scan state without losing stock or duplicating return records',async()=>{
 const t=await start();try{
  await t.merchant();const s=(await t.order({},'merchant')).value;await t.pickup(s.tracking);let d=await post(t,'/dispatches',{agencyId:t.agencies.Tanger.id,shipmentIds:[s.id]}),path='/dispatches/'+d.value.dispatch.id;await post(t,path+'/scan',{scan:s.tracking});assert.equal(row(t,s).status,'IN_TRANSIT');assert.equal((await post(t,path+'/cancel',{reason:'Reconstitution du départ'})).status,200);assert.equal(row(t,s).status,'PICKED_UP');assert.equal(row(t,s).custody_type,'WAREHOUSE');
  await send(t,[s]);await cancel(t,s);d=await wf(t,'/return-containers',{agencyId:t.agencies.Tanger.id});path='/return-containers/'+d.value.container.id;await wf(t,path+'/scan',{scan:s.tracking});assert.equal((await wf(t,path+'/cancel',{reason:'Transport reporté à demain'})).status,200);assert.equal(row(t,s).status,'CANCELLED');assert.equal((await get(t,'/return-containers')).value.cities[0].to_pack,1);await pack(t,[s]);assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM parcel_returns WHERE shipment_id=?').get(s.id).n,1);
 }finally{await t.stop();}
});

test('50 city returns track partial receipt, missing parcels and per-merchant handoff without introducing warehouse stock',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),shipments=[];for(let n=0;n<50;n++){const result=await t.order({recipient:'Retour '+n},'merchant');assert.equal(result.status,201);shipments.push(result.value);}await labels(t,shipments,'merchant');await send(t,shipments);for(const s of shipments)await cancel(t,s);
  const path=await pack(t,shipments);assert.equal((await get(t,path)).value.summary.expected,50);assert.equal((await get(t,'/return-containers')).value.cities[0].in_transit,50);
  for(const s of shipments.slice(0,49))assert.equal((await wf(t,path+'/receive-scan',{scan:s.tracking,condition:'SEALED'})).status,200);
  let d=(await get(t,path)).value;assert.equal(d.container.state,'SHIPPED');assert.equal(d.summary.notReceived,1);assert.equal((await get(t,'/return-containers')).value.total,1);assert.match((await get(t,path+'/print')).value,/49 \/ 50/);
  assert.equal((await wf(t,path+'/receive-scan',{scan:shipments[49].tracking,condition:'GOOD'})).status,200);d=(await get(t,path)).value;assert.equal(d.container.state,'RECEIVED');assert.equal(d.summary.received,50);assert.equal((await get(t,'/return-containers')).value.total,0);assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM stock_lots').get().n,0);
  const bon=await wf(t,'/merchant-returns',{merchantId:mid,shipmentIds:shipments.map(s=>s.id)});assert.equal(bon.status,201);const bpath='/merchant-returns/'+bon.value.bon.id;
  for(const s of shipments)assert.equal((await wf(t,bpath+'/scan',{scan:s.tracking})).status,200);assert.equal((await wf(t,bpath+'/complete',{receiverName:'Marchand test',proofReference:'BORDEREAU-50-SIGNE'})).status,200);assert.equal((await get(t,'/merchant-returns','merchant')).value.items.length,0);assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM shipments WHERE status='RETURNED_MERCHANT'").get().n,50);
 }finally{await t.stop();}
});

test('additive network migration is idempotent and preserves last scans and return receipts',async()=>{
 const t=await start();try{
  await t.merchant();const s=(await t.order({},'merchant')).value;await send(t,[s]);await cancel(t,s);const path=await pack(t,[s]);await wf(t,path+'/receive-scan',{scan:s.tracking,condition:'SEALED'});const before=row(t,s),detail=(await get(t,path)).value;networkSchema(t.db);networkSchema(t.db);assert.deepEqual(row(t,s),before);assert.deepEqual((await get(t,path)).value,detail);assert.equal(t.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{await t.stop();}
});

test('changed product ownership rolls back the entire stock return receipt until corrected',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),other=await t.merchant('Autre propriétaire','other'),pid=await stock(t,mid),s=(await t.order({source:'STOCK',items:[{productId:pid,quantity:2}]},'merchant')).value;await send(t,[s]);await cancel(t,s);const path=await pack(t,[s]);
  t.db.prepare('UPDATE inventory_products SET merchant_id=? WHERE id=?').run(other,pid);assert.equal((await wf(t,path+'/receive-scan',{scan:s.tracking,condition:'GOOD'})).status,409);assert.equal(row(t,s).custody_type,'RETURN_TRANSIT');assert.equal(row(t,s).status,'RETURNING');assert.equal((await get(t,path)).value.summary.received,0);assert.equal(t.db.prepare('SELECT state FROM parcel_returns WHERE shipment_id=?').get(s.id).state,'IN_TRANSIT');assert.equal(units(t,pid),8);
  t.db.prepare('UPDATE inventory_products SET merchant_id=? WHERE id=?').run(mid,pid);assert.equal((await wf(t,path+'/receive-scan',{scan:s.tracking,condition:'GOOD'})).status,200);assert.equal(units(t,pid),10);
 }finally{await t.stop();}
});

test('partner scans require physical departure and update agency custody without asserting an origin return receipt',async()=>{
 const t=await start();try{
  await t.merchant();const s=(await t.order({},'merchant')).value;await t.pickup(s.tracking);const dispatch=(await post(t,'/dispatches',{agencyId:t.agencies.Tanger.id,shipmentIds:[s.id]})).value.dispatch,path='/dispatches/'+dispatch.id;
  const sync=(eventId,status)=>t.request('/api/integrations/status',{method:'POST',token:t.agencies.Tanger.apiKey,data:{eventId,tracking:s.tracking,status}});
  await post(t,path+'/scan',{scan:s.tracking});assert.equal(row(t,s).status,'IN_TRANSIT');assert.equal((await sync('premature','RECU_PAR_VILLE')).status,409);await post(t,path+'/close');await post(t,path+'/ship');assert.equal((await sync('arrival','RECU_PAR_VILLE')).status,200);assert.equal(row(t,s).custody_type,'AGENCY');assert.equal((await get(t,'/agency-parcels')).value.total,1);
  assert.equal((await sync('distribution','MISE_EN_DISTRIBUTION')).status,200);assert.equal(row(t,s).custody_type,'DRIVER');assert.equal((await sync('refused','REFUSE')).status,200);assert.equal((await sync('reported-return','RETOURNE')).status,200);assert.equal(row(t,s).status,'RETURNING');assert.equal(row(t,s).custody_type,'DRIVER','a partner report does not invent a receipt at the origin');assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM stock_lots').get().n,0);assert.equal((await get(t,'/return-containers')).value.total,1);
 }finally{await t.stop();}
});

test('route cancellation preserves a customer cancellation recorded after the delivery scan',async()=>{
 const t=await start();try{
  await t.merchant();const driver=await account(t,'DRIVER','driver',t.agencies.Tanger.id),s=(await t.order({},'merchant')).value;await send(t,[s]);const tour=await wf(t,'/routes',{agencyId:t.agencies.Tanger.id,driverId:driver,shipmentIds:[s.id]}),path='/routes/'+tour.value.id;await wf(t,path+'/scan',{scan:s.tracking});await cancel(t,s);assert.equal((await wf(t,path+'/cancel',{reason:'Client annule avant le départ'})).status,200);assert.equal(row(t,s).status,'CANCELLED');assert.equal(row(t,s).custody_type,'DRIVER');assert.equal(row(t,s).driver_id,driver);assert.equal((await get(t,'/return-containers')).value.total,1);
 }finally{await t.stop();}
});

test('partial stock return requests cannot silently close the missing units through a city container',async()=>{
 const t=await start();try{
  const mid=await t.merchant(),pid=await stock(t,mid),s=(await t.order({source:'STOCK',items:[{productId:pid,quantity:2}]},'merchant')).value;await send(t,[s]);await cancel(t,s);const allocation=t.db.prepare('SELECT id FROM stock_allocations WHERE shipment_id=?').get(s.id);
  const ret=await wf(t,'/returns',{shipmentId:s.id,reason:'Une seule unité demandée par erreur',items:[{allocationId:allocation.id,quantity:1}]},'merchant');assert.equal(ret.status,201);const d=await wf(t,'/return-containers',{agencyId:t.agencies.Tanger.id}),path='/return-containers/'+d.value.container.id;
  assert.equal((await wf(t,path+'/scan',{scan:s.tracking})).status,409);assert.equal((await get(t,path)).value.summary.scanned,0);assert.equal(row(t,s).status,'CANCELLED');assert.equal(t.db.prepare('SELECT state FROM parcel_returns WHERE id=?').get(ret.value.id).state,'REQUESTED');assert.equal(units(t,pid),8);
 }finally{await t.stop();}
});
