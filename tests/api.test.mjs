import test from 'node:test';
import assert from 'node:assert/strict';
import {start,password} from './helpers.mjs';
import {xlsx} from '../src/excel.mjs';

test('one company only: setup once, email login, no company code or SaaS registration',async()=>{
 const t=await start({bootstrap:false});try{
  assert.equal((await t.request('/api/auth/setup')).value.setupRequired,true);
  const data={companyName:'Notre société',fullName:'Owner',email:'owner@example.ma',password};
  assert.equal((await t.request('/api/auth/setup',{method:'POST',data})).status,201);
  assert.equal((await t.request('/api/auth/setup',{method:'POST',data:{...data,companyName:'Autre société'}})).status,409);
  assert.equal((await t.request('/api/auth/register',{method:'POST',data})).status,410);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM company').get().n,1);
  assert.equal((await t.login(data.email)).status,200);
  const me=await t.request('/api/me');assert.equal(me.value.company.name,'Notre société');assert.equal(me.value.company.plan,undefined);assert.equal(me.value.company.slug,undefined);
  assert.equal((await t.request('/api/billing/usage')).status,404);
  assert.equal((await t.request('/api/auth/logout',{method:'POST',data:{}})).status,200);
  assert.equal((await t.request('/api/me')).status,401);
 }finally{await t.stop();}
});

test('driver and merchant permissions; private labels and redacted public tracking',async()=>{
 const t=await start();try{
  const driver=await t.request('/api/users',{method:'POST',data:{name:'Livreur',email:'driver@example.ma',password,role:'DRIVER'}});
  const a=await t.order({city:'Casablanca',recipient:'Ali <script>alert(1)</script>',driverId:driver.value.id}),b=await t.order({city:'Rabat'});
  assert.equal(a.status,201);await t.login('driver@example.ma','driver');
  assert.equal((await t.request('/api/shipments',{as:'driver'})).value.shipments.length,1);
  assert.equal((await t.request('/api/agencies',{as:'driver'})).status,403);
  assert.equal((await t.pickup(a.value.tracking,'driver')).status,403);
  assert.equal((await t.request(`/api/shipments/${b.value.id}/ticket`,{as:'driver'})).status,403);
  const ticket=await t.request(`/api/shipments/${a.value.id}/ticket`,{as:'driver'});assert.equal(ticket.status,200);assert.match(ticket.value,/code128/);assert.match(ticket.value,/qrcode/);assert.ok(!ticket.value.includes('<script>alert(1)</script>'));
  assert.equal((await t.request(`/api/shipments/${a.value.id}/status`,{method:'POST',as:'driver',data:{status:'OUT_FOR_DELIVERY'}})).status,409);
  await t.pickup(a.value.tracking);
  for(const status of ['OUT_FOR_DELIVERY','DELIVERED'])assert.equal((await t.request(`/api/shipments/${a.value.id}/status`,{method:'POST',as:'driver',data:{status}})).status,200);
  assert.equal((await t.request(`/api/shipments/${b.value.id}/status`,{method:'POST',as:'driver',data:{status:'DELIVERED'}})).status,403);
  const publicTracking=await t.request('/api/tracking/'+a.value.tracking,{as:'guest'});assert.equal(publicTracking.status,200);for(const key of ['recipient','phone','address','cod_centimes'])assert.equal(publicTracking.value[key],undefined);
  const publicPage=await t.request('/suivi/'+a.value.tracking,{as:'guest'});assert.ok(!publicPage.value.includes('0612345678'));assert.ok(!publicPage.value.includes('Rue Principale'));
  const own=await t.merchant('Soleil','soleil'),other=await t.merchant('Lune','lune'),m=await t.order({},'soleil');await t.order({},'lune');
  const list=(await t.request('/api/shipments',{as:'soleil'})).value.shipments;assert.equal(list.length,1);assert.equal(list[0].merchant_id,own);assert.equal(list[0].agency_id,t.agencies.Tanger.id);
  assert.equal((await t.order({merchantId:other},'soleil')).status,403);assert.equal((await t.order({agencyId:t.agencies.Tanger.id},'soleil')).status,403);
  assert.equal((await t.request(`/api/shipments/${b.value.id}/ticket`,{as:'soleil'})).status,403);
  for(const route of ['/api/agencies','/api/operations/queue','/api/dispatches','/api/merchants'])assert.equal((await t.request(route,{as:'soleil'})).status,403);
  assert.equal((await t.request('/api/cities',{as:'soleil'})).value.cities.length,4);
 }finally{await t.stop();}
});

test('controlled corrections, admin COD edits, internal notes and CSRF protection',async()=>{
 const t=await start();try{
  await t.request('/api/users',{method:'POST',data:{name:'Opérateur',email:'op@example.ma',password,role:'OPERATIONS'}});await t.login('op@example.ma','op');
  const a=await t.order(),patch=(data,as='admin')=>t.request(`/api/shipments/${a.value.id}`,{method:'PATCH',as,data});
  assert.equal((await patch({cod:300,reason:'Prix confirmé'},'op')).status,403);
  assert.equal((await patch({cod:300,reason:'x'})).status,400);
  for(const data of [{tracking:'HIJACK'},{company_id:'spoof'}])assert.equal((await patch({...data,reason:'Modification'})).status,400);
  assert.equal((await patch({city:'Rabat',cod:300,reason:'Client confirmé'})).status,200);
  let detail=(await t.request(`/api/shipments/${a.value.id}`)).value;assert.equal(detail.shipment.agency_id,t.agencies.Rabat.id);assert.equal(detail.shipment.cod_centimes,30000);
  assert.equal((await t.request(`/api/shipments/${a.value.id}/notes`,{method:'POST',as:'op',data:{message:'Préparer avec soin'}})).status,201);
  detail=(await t.request(`/api/shipments/${a.value.id}`)).value;assert.equal(detail.notes.length,1);
  assert.equal((await t.request('/api/agencies',{method:'POST',as:'op',data:{name:'Fès',city:'Fès'}})).status,403);
  assert.equal((await t.request('/api/merchants',{method:'POST',csrf:false,data:{name:'Blocked'}})).status,403);
  assert.equal((await t.request('/api/merchants',{method:'POST',origin:'https://untrusted.example',data:{name:'Blocked'}})).status,403);
  assert.equal((await t.agency('Fès')).city,'Fès');
  assert.equal((await t.request('/api/agencies',{method:'POST',data:{name:'Second Fes',city:' FES ',fee:20}})).status,409);
  assert.equal((await t.order({tracking:a.value.id})).status,201);assert.equal((await t.pickup(a.value.id)).status,409,'ambiguous ID/tracking must not scan the wrong parcel');
 }finally{await t.stop();}
});

test('external/stock preparation, FIFO pickup scans, wrong-city/duplicate/missing scans, Excel and departure',async()=>{
 const t=await start();try{
  const merchantId=await t.merchant(),p=await t.request('/api/inventory/products',{method:'POST',data:{sku:'SERUM-30',name:'Sérum 30 ml',merchantId}});
  for(const quantity of [2,8])await t.request('/api/inventory/receive',{method:'POST',data:{productId:p.value.id,quantity,location:'Casablanca A'}});
  const external=await t.order({},'merchant'),stock=await t.order({source:'STOCK',items:[{productId:p.value.id,quantity:5}]},'merchant'),wrong=await t.order({city:'Rabat'}),unpicked=await t.order();
  assert.equal(stock.status,201,JSON.stringify(stock.value));
  let inv=(await t.request('/api/inventory')).value.products[0];assert.equal(inv.on_hand,10);assert.equal(inv.reserved,5);
  const prep=await t.request(`/api/shipments/${stock.value.id}/preparation`);assert.match(prep.value,/Bon stock/);assert.match(prep.value,/SERUM-30/);
  assert.match((await t.request(`/api/shipments/${external.value.id}/preparation`)).value,/colis externe/);
  await t.pickup(external.value.tracking);assert.equal((await t.request('/api/inventory')).value.products[0].on_hand,10);
  assert.equal((await t.pickup('http://localhost:3000/suivi/'+stock.value.tracking)).status,200);assert.equal((await t.pickup(stock.value.id)).value.duplicate,true);
  inv=(await t.request('/api/inventory')).value.products[0];assert.equal(inv.on_hand,5);assert.equal(inv.reserved,0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM stock_allocations WHERE state='DISPATCHED'").get().n,2);
  await t.pickup(wrong.value.tracking);
  const d=await t.request('/api/dispatches',{method:'POST',data:{agencyId:t.agencies.Tanger.id}});assert.equal(d.status,201);assert.equal(d.value.summary.expected,2);
  const route='/api/dispatches/'+d.value.dispatch.id,scan=code=>t.request(route+'/scan',{method:'POST',data:{scan:code}});
  assert.equal((await t.request(route+'/export',{method:'POST',data:{}})).status,409);
  assert.equal((await scan(wrong.value.tracking)).status,409);assert.equal((await scan(unpicked.value.tracking)).status,409);assert.equal((await scan('UNKNOWN-TRACKING')).status,404);
  assert.equal((await scan(external.value.tracking)).status,200);assert.equal((await scan(external.value.tracking)).status,409);
  assert.equal((await t.request(route+'/close',{method:'POST',data:{}})).status,409);
  assert.equal((await scan(stock.value.id)).value.summary.missing,0);
  assert.equal((await t.request(route+'/close',{method:'POST',data:{}})).status,200);
  const exported=await t.request(route+'/export',{method:'POST',data:{}});assert.equal(exported.status,200);const rows=xlsx('import',exported.value);assert.equal(rows.length,3);assert.ok(rows.slice(1).every(row=>row[4]==='Tanger'));
  assert.equal(t.db.prepare('SELECT status FROM shipments WHERE id=?').get(stock.value.id).status,'PICKED_UP');
  assert.equal((await t.request(route+'/ship',{method:'POST',data:{}})).status,200);assert.equal((await t.request(route+'/ship',{method:'POST',data:{}})).status,409);
  assert.equal(t.db.prepare('SELECT status FROM shipments WHERE id=?').get(stock.value.id).status,'IN_TRANSIT');assert.equal((await scan(stock.value.tracking)).status,409);
 }finally{await t.stop();}
});

test('container/fee snapshots, late parcels, cancellation and authenticated agency events',async()=>{
 const t=await start();try{
  const a=await t.order();await t.pickup(a.value.tracking);
  const sync=(data,token=t.agencies.Tanger.apiKey)=>t.request('/api/integrations/status',{method:'POST',token,data:{eventId:'event-1',tracking:a.value.tracking,status:'RAMASSE',...data}});
  assert.equal((await sync({})).status,409);
  const d=(await t.request('/api/dispatches',{method:'POST',data:{agencyId:t.agencies.Tanger.id}})).value,route='/api/dispatches/'+d.dispatch.id;
  const late=await t.order();await t.pickup(late.value.tracking);
  assert.equal((await t.request(route+'/scan',{method:'POST',data:{scan:late.value.tracking}})).status,409);
  assert.equal((await t.request('/api/dispatches',{method:'POST',data:{agencyId:t.agencies.Tanger.id}})).status,409);
  assert.equal((await t.request(`/api/agencies/${t.agencies.Tanger.id}`,{method:'PATCH',data:{fee:25}})).status,200);
  assert.equal((await t.request(`/api/shipments/${a.value.id}`,{method:'PATCH',data:{address:'Rue 99',reason:'Adresse corrigée'}})).status,409);
  assert.equal((await t.request(`/api/shipments/${a.value.id}/status`,{method:'POST',data:{status:'OUT_FOR_DELIVERY'}})).status,409);
  await t.request(route+'/scan',{method:'POST',data:{scan:a.value.tracking}});await t.request(route+'/close',{method:'POST',data:{}});
  const next=await t.request('/api/dispatches',{method:'POST',data:{agencyId:t.agencies.Tanger.id}});assert.equal(next.status,201);assert.equal(next.value.summary.expected,1);
  assert.equal((await t.request('/api/dispatches/'+next.value.dispatch.id+'/scan',{method:'POST',data:{scan:a.value.tracking}})).status,409);
  await t.request(route+'/ship',{method:'POST',data:{}});assert.equal(t.db.prepare('SELECT agency_fee_centimes FROM shipments WHERE id=?').get(a.value.id).agency_fee_centimes,2000);
  const edit=await t.request(`/api/shipments/${a.value.id}`,{method:'PATCH',data:{address:'Rue 99',reason:'Adresse corrigée'}});assert.equal(edit.status,200);assert.equal(edit.value.pendingAgencyUpdate,true);
  assert.equal((await sync({status:'EN_LIVRAISON'})).status,200);assert.equal((await sync({status:'EN_LIVRAISON'})).value.duplicate,true);
  assert.equal((await sync({eventId:'event-2',status:'LIVRE'})).status,200);assert.equal((await sync({eventId:'event-3',status:'EN_COURS'})).status,409);
  assert.equal((await sync({eventId:'wrong-agency'},t.agencies.Rabat.apiKey)).status,404);assert.equal((await sync({eventId:'bad-key'},'invalid')).status,401);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n,0);
  assert.equal((await t.request('/api/ledger/collect',{method:'POST',data:{shipmentId:a.value.id}})).status,201);assert.equal((await t.request('/api/ledger/collect',{method:'POST',data:{shipmentId:a.value.id}})).status,409);
  assert.equal((await t.request('/api/dispatches/'+next.value.dispatch.id+'/cancel',{method:'POST',data:{reason:'Reconstitution du lot'}})).status,200);
  assert.equal((await t.request('/api/dispatches',{method:'POST',data:{agencyId:t.agencies.Tanger.id}})).value.summary.expected,1);
 }finally{await t.stop();}
});

test('stock shortage rolls back orders; cancellation releases stock; CSV reports invalid cities and duplicates',async()=>{
 const t=await start();try{
  const merchantId=await t.merchant(),p=await t.request('/api/inventory/products',{method:'POST',data:{sku:'ITEM-01',name:'Article',merchantId}});
  await t.request('/api/inventory/receive',{method:'POST',data:{productId:p.value.id,quantity:3}});
  assert.equal((await t.order({source:'STOCK',items:[{productId:p.value.id,quantity:4}]},'merchant')).status,409);assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM shipments').get().n,0);
  assert.equal((await t.order({source:'STOCK'},'merchant')).status,400);assert.equal((await t.order({source:'EXTERNAL',items:[{productId:p.value.id,quantity:1}]},'merchant')).status,400);
  const a=await t.order({source:'STOCK',items:[{productId:p.value.id,quantity:2}]},'merchant');assert.equal(a.status,201);
  assert.equal((await t.request('/api/inventory/dispatch',{method:'POST',data:{shipmentId:a.value.id}})).status,410);
  assert.equal((await t.request(`/api/shipments/${a.value.id}/status`,{method:'POST',data:{status:'CANCELLED'}})).status,200);
  const inv=(await t.request('/api/inventory')).value.products[0];assert.equal(inv.on_hand,3);assert.equal(inv.reserved,0);assert.equal((await t.pickup(a.value.tracking)).status,409);
  const csv='Tracking,Destinataire,Téléphone,Adresse,Ville,COD,Description\nTEST-1001,Client,0612345678,Rue 1,Tanger,199,Colis\nTEST-1002,Client,0612345678,Rue 2,Ville absente,99,Colis\n';
  const first=await t.request('/api/import/orders',{method:'POST',raw:csv,contentType:'text/csv'});assert.equal(first.status,200);assert.equal(first.value.inserted,1);assert.equal(first.value.skipped,1);
  const again=await t.request('/api/import/orders',{method:'POST',raw:csv,contentType:'text/csv'});assert.equal(again.value.inserted,0);assert.equal(again.value.skipped,2);
 }finally{await t.stop();}
});
