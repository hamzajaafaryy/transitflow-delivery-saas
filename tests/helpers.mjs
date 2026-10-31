import assert from 'node:assert/strict';
import {buildServer} from '../src/server.mjs';
import {openDb} from '../src/db.mjs';
export const password='strong-password-for-tests-123';
export async function start({bootstrap=true,db=openDb(':memory:')}={}){
 const instance=buildServer({db,sessionSecret:'a-fixed-test-secret-with-adequate-length-123',sameOrigin:'http://localhost:3000'});
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${instance.server.address().port}`,cookies=new Map();
 async function request(route,{method='GET',data,as='admin',token,raw,contentType,csrf=true,origin}={}){
  const headers={};if(csrf)headers['X-Requested-With']='delivery-ui';if(origin)headers.Origin=origin;
  if(data!==undefined)headers['Content-Type']='application/json';if(raw)headers['Content-Type']=contentType;
  if(cookies.has(as))headers.Cookie=cookies.get(as);if(token)headers.Authorization=`Bearer ${token}`;
  const res=await fetch(base+route,{method,headers,body:data!==undefined?JSON.stringify(data):raw});
  const cookie=res.headers.get('set-cookie');if(cookie?.includes('dn_session='))cookies.set(as,cookie.split(';')[0]);
  const type=res.headers.get('content-type')||'';
  const value=type.includes('json')?await res.json():type.includes('text/')?await res.text():Buffer.from(await res.arrayBuffer());
  return {status:res.status,value,headers:res.headers};
 }
 const login=(email,as='admin')=>request('/api/auth/login',{method:'POST',as,data:{email,password}});
 const agency=async(city,fee=20,kind='PARTNER')=>{const r=await request('/api/agencies',{method:'POST',data:{name:'Agence '+city,city,fee,kind}});assert.equal(r.status,201,JSON.stringify(r.value));return r.value;};
 const merchant=async(name='Boutique',as='merchant')=>{
  const m=await request('/api/merchants',{method:'POST',data:{name}});assert.equal(m.status,201);
  const email=as+'@example.ma',u=await request('/api/users',{method:'POST',data:{name,email,password,role:'MERCHANT',merchantId:m.value.id}});assert.equal(u.status,201);assert.equal((await login(email,as)).status,200);return m.value.id;
 };
 const order=(data={},as='admin')=>request('/api/shipments',{method:'POST',as,data:{recipient:'Client Test',phone:'0612345678',city:'Tanger',address:'Rue Principale 12',cod:200,...data}});
 const pickup=(scan,as='admin')=>request('/api/operations/ramassage',{method:'POST',as,data:{scan}});
 const stop=()=>new Promise(resolve=>instance.server.close(()=>{db.close();resolve();}));
 const agencies={};
 if(bootstrap){
  assert.equal((await request('/api/auth/setup',{method:'POST',data:{companyName:'Atlas Livraison',fullName:'Admin',email:'admin@example.ma',password}})).status,201);
  assert.equal((await login('admin@example.ma')).status,200);
  for(const city of ['Tanger','Casablanca','Rabat','Agadir'])agencies[city]=await agency(city,city==='Tanger'?20:30,city==='Casablanca'?'INTERNAL':'PARTNER');
 }
 return {db,request,login,agency,merchant,order,pickup,stop,agencies};
}
