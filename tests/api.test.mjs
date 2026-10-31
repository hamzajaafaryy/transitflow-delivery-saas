import test from 'node:test';import assert from 'node:assert/strict';
import { buildServer } from '../src/server.mjs';import {openDb} from '../src/db.mjs';

async function start(){
 const instance=buildServer({db:openDb(':memory:'),sessionSecret:'a-fixed-test-secret-with-adequate-length-123',sameOrigin:'http://localhost:3000'});
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${instance.server.address().port}`;
 const cookies=new Map();
 async function request(route,{method='GET',data,as='A',token,raw,contentType}={}){
  const headers={};if(data!==undefined){headers['Content-Type']='application/json';headers['X-Requested-With']='delivery-ui';}
  if(raw){headers['Content-Type']=contentType;headers['X-Requested-With']='delivery-ui';}
  if(method!=='GET'&&!token)headers['X-Requested-With']='delivery-ui';
  if(cookies.has(as))headers.Cookie=cookies.get(as);if(token)headers.Authorization=`Bearer ${token}`;
  const res=await fetch(base+route,{method,headers,body:data!==undefined?JSON.stringify(data):raw});
  const cookie=res.headers.get('set-cookie');if(cookie?.includes('dn_session='))cookies.set(as,cookie.split(';')[0]);
  const ct=res.headers.get('content-type')||'';
  const value=ct.includes('json')?await res.json():await res.arrayBuffer();return {status:res.status,value,headers:res.headers};
 }
 return {request,stop:()=>new Promise(r=>instance.server.close(()=>{instance.db.close();r();}))};
}
test('tenant isolation, Excel manifest and authenticated partner scan synchronization',async()=>{
 const {request,stop}=await start();
 try{
  const register=async(company,as)=>request('/api/auth/register',{method:'POST',as,data:{companyName:company,slug:company.toLowerCase(),fullName:'Admin',email:'admin@example.ma',password:'very-strong-passphrase-123'}});
  assert.equal((await register('Alpha','A')).status,201);assert.equal((await register('Beta','B')).status,201);
  const login=async(company,as)=>request('/api/auth/login',{method:'POST',as,data:{company:company.toLowerCase(),email:'admin@example.ma',password:'very-strong-passphrase-123'}});
  assert.equal((await login('Alpha','A')).status,200);assert.equal((await login('Beta','B')).status,200);
  const p=await request('/api/partners',{method:'POST',as:'A',data:{name:'Oscario',cities:'Tanger',fee:18}});
  assert.equal(p.status,201);assert.ok(p.value.apiKey.startsWith('dn_'));
  const tracking='DNTEST20260001';
  const shipment=await request('/api/shipments',{method:'POST',as:'A',data:{tracking,recipient:'Client One',phone:'0612345678',address:'Street 11',city:'Tanger',cod:200,partnerId:p.value.id}});
  assert.equal(shipment.status,201);assert.equal(shipment.value.status,'ASSIGNED_PARTNER');
  const beta=await request('/api/shipments',{as:'B'});assert.equal(beta.value.shipments.length,0);
  const man=await request(`/api/partners/${p.value.id}/export`,{method:'POST',as:'A',data:{}});assert.equal(man.status,200);
  const bytes=Buffer.from(man.value);assert.equal(bytes.slice(0,2).toString(),'PK');
  const partnerList=await request('/api/partners',{as:'B'});assert.equal(partnerList.value.partners.length,0);
  let sync=await request('/api/integrations/status',{method:'POST',token:p.value.apiKey,data:{eventId:'scan1',tracking,status:'RAMASSE'}});
  assert.equal(sync.status,200);assert.equal(sync.value.status,'PICKED_UP');
  sync=await request('/api/integrations/status',{method:'POST',token:p.value.apiKey,data:{eventId:'scan1',tracking,status:'RAMASSE'}});
  assert.equal(sync.value.duplicate,true);
  sync=await request('/api/integrations/status',{method:'POST',token:'bad-key',data:{eventId:'hack',tracking,status:'LIVRE'}});
  assert.equal(sync.status,401);
  sync=await request('/api/integrations/status',{method:'POST',token:p.value.apiKey,data:{eventId:'scan2',tracking,status:'RETOURNE'}});assert.equal(sync.status,409);
  for(const [eventId,external] of [['scan3','EN_COURS'],['scan4','EN_LIVRAISON'],['scan5','LIVRE']]){
    const r=await request('/api/integrations/status',{method:'POST',token:p.value.apiKey,data:{eventId,tracking,status:external}});assert.equal(r.status,200,JSON.stringify(r.value));
  }
  const trackingPublic=await request(`/api/tracking/${tracking}`,{as:'B'});assert.equal(trackingPublic.value.status,'DELIVERED');assert.equal(trackingPublic.value.phone,undefined);
  assert.equal((await request('/api/ledger/collect',{method:'POST',as:'A',data:{shipmentId:shipment.value.id}})).status,201);
  assert.equal((await request('/api/ledger/collect',{method:'POST',as:'A',data:{shipmentId:shipment.value.id}})).status,409);
  const bTrack=await request('/api/shipments',{as:'B'});assert.equal(bTrack.value.shipments.length,0);
 }finally{await stop();}
});
test('driver uses shared login but cannot see other orders or administrative APIs',async()=>{
 const {request,stop}=await start();
 try{
  await request('/api/auth/register',{method:'POST',data:{companyName:'Gamma',slug:'gamma',fullName:'Boss',email:'boss@example.ma',password:'supersecurepass-123'}});
  await request('/api/auth/login',{method:'POST',data:{company:'gamma',email:'boss@example.ma',password:'supersecurepass-123'}});
  const driver=await request('/api/users',{method:'POST',data:{name:'Livreur One',email:'driver@example.ma',password:'supersecurepass-456',role:'DRIVER'}});assert.equal(driver.status,201);
  const a=await request('/api/shipments',{method:'POST',data:{recipient:'A',phone:'0612345678',city:'Casablanca',address:'Avenue 1',cod:90}});
  const b=await request('/api/shipments',{method:'POST',data:{recipient:'B',phone:'0612345678',city:'Rabat',address:'Avenue 2',cod:50}});
  await request('/api/shipments/assign',{method:'POST',data:{shipmentId:a.value.id,driverId:driver.value.id}});
  await request('/api/auth/login',{method:'POST',as:'driver',data:{company:'gamma',email:'driver@example.ma',password:'supersecurepass-456'}});
  const orders=await request('/api/shipments',{as:'driver'});assert.equal(orders.value.shipments.length,1);
  assert.equal((await request('/api/partners',{as:'driver'})).status,403);
  assert.equal((await request(`/api/shipments/${b.value.id}/status`,{method:'POST',as:'driver',data:{status:'DELIVERED'}})).status,403);
 }finally{await stop();}
});
test('Fulfillment FIFO reservations do not overbook and dispatch is separate',async()=>{
 const {request,stop}=await start();
 try{
  await request('/api/auth/register',{method:'POST',data:{companyName:'StockCo',slug:'stockco',fullName:'Boss',email:'boss@stockco.ma',password:'supersecurepass-123'}});
  await request('/api/auth/login',{method:'POST',data:{company:'stockco',email:'boss@stockco.ma',password:'supersecurepass-123'}});
  const prod=await request('/api/inventory/products',{method:'POST',data:{sku:'SKU-01',name:'Serum 30ml'}});assert.equal(prod.status,201);
  const receive=async quantity=>request('/api/inventory/receive',{method:'POST',data:{productId:prod.value.id,quantity}});
  await receive(2);await new Promise(r=>setTimeout(r,5));await receive(4);
  const ship=await request('/api/shipments',{method:'POST',data:{recipient:'Client',phone:'0611111111',city:'Agadir',address:'Rue 1',cod:100}});
  const reserve=async quantity=>request('/api/inventory/reserve',{method:'POST',data:{productId:prod.value.id,shipmentId:ship.value.id,quantity}});
  assert.equal((await reserve(5)).status,201);
  assert.equal((await reserve(2)).status,409);
  let inv=await request('/api/inventory');assert.equal(inv.value.products[0].available,1);assert.equal(inv.value.products[0].reserved,5);
  const dispatch=await request('/api/inventory/dispatch',{method:'POST',data:{shipmentId:ship.value.id}});assert.equal(dispatch.status,200);
  inv=await request('/api/inventory');assert.equal(inv.value.products[0].on_hand,1);assert.equal(inv.value.products[0].reserved,0);
 }finally{await stop();}
});
test('merchant access is explicitly bound to merchant ID, not user name',async()=>{
 const {request,stop}=await start();
 try{
  await request('/api/auth/register',{method:'POST',data:{companyName:'Merchants',slug:'merchants',fullName:'Admin',email:'admin@m.test',password:'very-strong-password-123'}});
  await request('/api/auth/login',{method:'POST',data:{company:'merchants',email:'admin@m.test',password:'very-strong-password-123'}});
  const a=await request('/api/merchants',{method:'POST',data:{name:'Boutique A'}});
  const b=await request('/api/merchants',{method:'POST',data:{name:'Boutique B'}});
  const order=async(merchantId)=>request('/api/shipments',{method:'POST',data:{recipient:'Destinataire',phone:'0612345678',city:'Tanger',address:'Rue Principale',merchantId}});
  await order(a.value.id);await order(b.value.id);
  const m=await request('/api/users',{method:'POST',data:{name:'Operator Different Name',email:'merchant@m.test',password:'very-strong-password-456',role:'MERCHANT',merchantId:a.value.id}});assert.equal(m.status,201);
  await request('/api/auth/login',{method:'POST',as:'M',data:{company:'merchants',email:'merchant@m.test',password:'very-strong-password-456'}});
  const list=await request('/api/shipments',{as:'M'});assert.equal(list.value.shipments.length,1);assert.equal(list.value.shipments[0].merchant_id,a.value.id);
  const stats=await request('/api/stats',{as:'M'});assert.equal(stats.value.total,1);
 }finally{await stop();}
});
