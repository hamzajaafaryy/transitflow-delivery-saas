import test from 'node:test';
import assert from 'node:assert/strict';
import {start,password} from './helpers.mjs';

test('shipment workspace filters, phone/ID/merchant search, sorting and pagination retain account boundaries',async()=>{
 const t=await start();try{
  const mid=await t.merchant('Boutique Atlas','atlas'),other=await t.merchant('Boutique Autre','other');
  const a=(await t.order({phone:'0611111111',cod:20},'atlas')).value,b=(await t.order({city:'Rabat',phone:'0622222222',cod:90},'atlas')).value;
  const product=await t.request('/api/inventory/products',{method:'POST',data:{sku:'FILTER-TEST',name:'Article',merchantId:mid}});await t.request('/api/inventory/receive',{method:'POST',data:{productId:product.value.id,quantity:5}});
  const c=(await t.order({source:'STOCK',items:[{productId:product.value.id,quantity:1}],phone:'0633333333',cod:40},'atlas')).value,hidden=(await t.order({cod:400},'other')).value;
  const query=async value=>(await t.request('/api/shipments?'+new URLSearchParams(value),{as:'atlas'})).value;
  assert.equal((await query({city:'Tanger'})).total,2);assert.deepEqual((await query({source:'STOCK'})).shipments.map(x=>x.id),[c.id]);
  assert.deepEqual((await query({q:'061111'})).shipments.map(x=>x.id),[a.id]);assert.deepEqual((await query({q:b.id})).shipments.map(x=>x.id),[b.id]);
  assert.equal((await query({q:'Boutique Atlas'})).total,3);assert.equal((await query({q:hidden.id})).total,0);assert.equal((await query({merchantId:other})).total,0);
  const sorted=await query({sort:'cod_desc',limit:2,offset:1});assert.equal(sorted.total,3);assert.deepEqual(sorted.shipments.map(x=>x.cod_centimes),[4000,2000]);
  assert.equal((await t.request('/api/shipments?source=INVALID',{as:'atlas'})).status,400);assert.equal((await t.request('/api/shipments?sort=invalid',{as:'atlas'})).status,400);
 }finally{await t.stop();}
});

test('control tower destinations, recent shipments and activity remain scoped to merchant and agency',async()=>{
 const t=await start();try{
  await t.merchant('Boutique Atlas','atlas');await t.merchant('Autre boutique','other');
  const own=(await t.order({},'atlas')).value,foreign=(await t.order({city:'Rabat'},'other')).value;
  await t.request('/api/users',{method:'POST',data:{name:'Agent Tanger',email:'agent@workspace.ma',password,role:'AGENCY_AGENT',agencyId:t.agencies.Tanger.id}});await t.login('agent@workspace.ma','agent');
  for(const as of ['atlas','agent']){const r=await t.request('/api/workflow/overview',{as});assert.equal(r.status,200,JSON.stringify(r.value));assert.deepEqual(r.value.cityDistribution.map(x=>[x.city,x.total]),[['Tanger',1]]);assert.deepEqual(r.value.recentShipments.map(x=>x.id),[own.id]);assert.ok(r.value.recentActivity.every(x=>x.tracking!==foreign.tracking));assert.equal(r.value.cashHeldCentimes,null);}
  const admin=(await t.request('/api/workflow/overview')).value;assert.equal(admin.cityDistribution.reduce((n,x)=>n+x.total,0),2);assert.equal(admin.recentShipments.length,2);
 }finally{await t.stop();}
});

test('dispatch readiness counts reflect reserving and cancelling a city container',async()=>{
 const t=await start();try{
  const order=(await t.order()).value;await t.pickup(order.tracking);
  const ready=async()=>((await t.request('/api/agencies')).value.agencies.find(a=>a.id===t.agencies.Tanger.id)).ready_count;
  assert.equal(await ready(),1);
  const d=await t.request('/api/dispatches',{method:'POST',data:{agencyId:t.agencies.Tanger.id}});assert.equal(d.status,201);assert.equal(await ready(),0);
  await t.request('/api/dispatches/'+d.value.dispatch.id+'/cancel',{method:'POST',data:{reason:'Reconstitution du lot test'}});assert.equal(await ready(),1);
 }finally{await t.stop();}
});
