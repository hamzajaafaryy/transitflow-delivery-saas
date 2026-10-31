import test from 'node:test';
import assert from 'node:assert/strict';
import {buildServer} from '../src/server.mjs';
import {openDb} from '../src/db.mjs';

async function setup(){
 const db=openDb(':memory:');const instance=buildServer({db,sessionSecret:'test-secret-merchant-finance-abcdefghijkl',sameOrigin:'http://localhost:3000'});
 await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${instance.server.address().port}`;const cookies=new Map();
 async function request(path,{method='GET',as='admin',data}={}){
  const headers={'X-Requested-With':'delivery-ui'};if(data!==undefined)headers['Content-Type']='application/json';
  if(cookies.get(as))headers.cookie=cookies.get(as);
  const r=await fetch(base+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
  const cookie=r.headers.get('set-cookie');if(cookie?.startsWith('dn_session='))cookies.set(as,cookie.split(';')[0]);
  const type=r.headers.get('content-type')||'',value=type.includes('json')?await r.json():await r.text();
  return {status:r.status,value};
 }
 const createAdmin=async(slug,as='admin')=>{
  assert.equal((await request('/api/auth/setup',{method:'POST',as,data:{companyName:slug,slug,fullName:'Boss',email:'boss@'+slug+'.ma',password:'a-strong-password-123'}})).status,201);
  assert.equal((await request('/api/auth/login',{method:'POST',as,data:{company:slug,email:'boss@'+slug+'.ma',password:'a-strong-password-123'}})).status,200);
  for(const city of ['Tanger','Casablanca'])assert.equal((await request('/api/agencies',{method:'POST',as,data:{name:'Agence '+city,city,fee:20}})).status,201);
 };
 const createMerchant=async(name,email,as)=>{
  const m=await request('/api/merchants',{method:'POST',data:{name}});assert.equal(m.status,201);
  const u=await request('/api/users',{method:'POST',data:{name:'User '+name,email,password:'another-strong-password-456',role:'MERCHANT',merchantId:m.value.id}});assert.equal(u.status,201);
  await request('/api/auth/login',{method:'POST',as,data:{company:'atlas',email,password:'another-strong-password-456'}});
  return m.value.id;
 };
 return {db,request,createAdmin,createMerchant,stop:()=>new Promise(r=>instance.server.close(()=>{db.close();r();}))};
}

test('merchant stock is linked to actual merchant and warehouse and cannot leak to another account',async()=>{
 const t=await setup();try{
  await t.createAdmin('atlas');const a=await t.createMerchant('Soleil','soleil@atlas.ma','soleil');const b=await t.createMerchant('Lune','lune@atlas.ma','lune');
  const product=await t.request('/api/inventory/products',{method:'POST',data:{sku:'SERUM-30',name:'Sérum 30 ml',merchantId:a}});assert.equal(product.status,201);
  await t.request('/api/inventory/receive',{method:'POST',data:{productId:product.value.id,quantity:50,location:'Casablanca A'}});
  await t.request('/api/inventory/receive',{method:'POST',data:{productId:product.value.id,quantity:10,location:'Tanger B'}});
  const stock=await t.request('/api/merchant/stock',{as:'soleil'});assert.equal(stock.status,200);assert.equal(stock.value.summary.unitsPhysical,60);assert.equal(stock.value.products[0].available,60);assert.equal(stock.value.warehouses.length,2);
  assert.equal((await t.request('/api/merchant/stock',{as:'lune'})).value.summary.unitsPhysical,0);
  assert.equal((await t.request('/api/merchant/stock?merchantId='+a,{as:'lune'})).status,403);
  assert.equal((await t.request('/api/finance/merchant-list',{as:'soleil'})).status,403);
  const order=await t.request('/api/merchant/orders',{method:'POST',as:'soleil',data:{recipient:'Client A',phone:'0612345678',city:'Tanger',address:'Rue 1',cod:200,items:[{productId:product.value.id,quantity:55}]}});
  assert.equal(order.status,201,JSON.stringify(order.value));
  const reserved=(await t.request('/api/merchant/stock',{as:'soleil'})).value;assert.equal(reserved.summary.unitsReserved,55);assert.equal(reserved.summary.unitsAvailable,5);assert.equal(reserved.allocations.length,2);
  const insufficient=await t.request('/api/merchant/orders',{method:'POST',as:'soleil',data:{recipient:'Client B',phone:'0612345678',city:'Tanger',address:'Rue 2',cod:100,items:[{productId:product.value.id,quantity:6}]}});assert.equal(insufficient.status,409);
  const merchantOrders=await t.request('/api/shipments',{as:'soleil'});assert.equal(merchantOrders.value.shipments.length,1,'transaction should roll back order when insufficient');
  assert.equal((await t.request('/api/merchant/orders',{method:'POST',as:'lune',data:{recipient:'Client',phone:'0612345678',city:'Tanger',address:'Rue 9',items:[{productId:product.value.id,quantity:1}]}})).status,404);
  assert.equal((await t.request('/api/merchant/orders',{method:'POST',as:'soleil',data:{recipient:'Client',phone:'0612345678',city:'Tanger',address:'Rue 9',agencyId:'fake'}})).status,403);
  assert.equal((await t.request('/api/merchant/orders',{method:'POST',as:'soleil',data:{recipient:'Client',phone:'0612345678',city:'Tanger',address:'Rue 9',merchantId:b}})).status,403);
 }finally{await t.stop();}
});

test('previous day reports and payout statements separate DELIVERED from collected and paid',async()=>{
 const t=await setup();try{
  await t.createAdmin('atlas');const m=await t.createMerchant('Boutique','boutique@atlas.ma','merchant');
  const shipment=await t.request('/api/shipments',{method:'POST',data:{recipient:'Client',phone:'0612345678',city:'Casablanca',address:'Rue 1',cod:200,merchantId:m}});
  assert.equal(shipment.status,201);
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Casablanca',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()-86400000));
  const date=(/^\d{4}-/.test(day)?day:new Date(Date.now()-86400000).toISOString().slice(0,10));
  t.db.prepare("UPDATE shipments SET status='DELIVERED',delivered_at=? WHERE id=?").run(`${date}T12:00:00.000Z`,shipment.value.id);
  const period=`period=date&date=${date}`;
  const before=await t.request('/api/merchant/overview?'+period,{as:'merchant'});assert.equal(before.status,200,JSON.stringify(before.value));assert.equal(before.value.summary.delivered,1);assert.equal(before.value.summary.grossDeliveredCentimes,20000);assert.equal(before.value.summary.collectedCentimes,0);
  assert.equal((await t.request('/api/finance/merchant-statements',{method:'POST',data:{merchantId:m,date}})).status,409);
  const rate=await t.request('/api/finance/merchant-rates',{method:'POST',data:{merchantId:m,city:'Casablanca',feeCentimes:3000}});assert.equal(rate.status,200);
  const afterRate=await t.request('/api/merchant/overview?'+period,{as:'merchant'});assert.equal(afterRate.value.deliveries[0].feeCentimes,3000);assert.equal(afterRate.value.summary.collectedReadyForStatementCentimes,0);
  assert.equal((await t.request('/api/ledger/collect',{method:'POST',data:{shipmentId:shipment.value.id}})).status,201);
  const ready=await t.request('/api/merchant/overview?'+period,{as:'merchant'});assert.equal(ready.value.summary.collectedReadyForStatementCentimes,17000);
  const st=await t.request('/api/finance/merchant-statements',{method:'POST',data:{merchantId:m,date}});assert.equal(st.status,201,JSON.stringify(st.value));assert.equal(st.value.netCentimes,17000);
  const printed=await t.request('/api/merchant/deliveries/print?'+period,{as:'merchant'});
  assert.equal(printed.status,200);assert.match(printed.value,/Rapport des livraisons/);assert.match(printed.value,/Casablanca/);
  assert.equal((await t.request('/api/finance/merchant-statements',{method:'POST',data:{merchantId:m,date}})).status,409);
  const preview=await t.request('/api/merchant/statements',{as:'merchant'});assert.equal(preview.value.statements[0].status,'DRAFT');
  const html=await t.request(`/api/merchant/statements/${st.value.id}/print`,{as:'merchant'});assert.equal(html.status,200);assert.match(html.value,/17[\s\u00a0\u202f]?0?[,\.]00 MAD/);assert.ok(!html.value.includes('<script>'));
  assert.equal((await t.request(`/api/finance/merchant-statements/${st.value.id}/mark-paid`,{method:'POST',as:'merchant',data:{paymentReference:'X-Y-Z-123'}})).status,403);
  assert.equal((await t.request(`/api/finance/merchant-statements/${st.value.id}/mark-paid`,{method:'POST',data:{paymentReference:'X-Y-Z-123'}})).status,409);
  assert.equal((await t.request(`/api/finance/merchant-statements/${st.value.id}/confirm`,{method:'POST',data:{}})).status,200);
  assert.equal((await t.request(`/api/finance/merchant-statements/${st.value.id}/mark-paid`,{method:'POST',data:{paymentReference:'VIR-2026-002'}})).status,200);
  const paid=await t.request('/api/merchant/overview?'+period,{as:'merchant'});assert.equal(paid.value.summary.statementsPaidCentimes,17000);assert.equal(paid.value.summary.statementsAwaitingPaymentCentimes,0);
 }finally{await t.stop();}
});
