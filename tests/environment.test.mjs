import test from 'node:test';
import assert from 'node:assert/strict';
import {publicBaseUrl} from '../src/environment.mjs';
import {buildServer} from '../src/server.mjs';

const codespace={CODESPACES:'true',CODESPACE_NAME:'hamza-test-abc123',GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:'app.github.dev'};

test('Codespaces resolves its forwarded browser origin even with the sample localhost configuration',()=>{
 assert.equal(publicBaseUrl(codespace),'https://hamza-test-abc123-3000.app.github.dev');
 assert.equal(publicBaseUrl({...codespace,PUBLIC_BASE_URL:'http://localhost:3000'}),'https://hamza-test-abc123-3000.app.github.dev');
 assert.equal(publicBaseUrl({...codespace,PORT:'3100'}),'https://hamza-test-abc123-3100.app.github.dev');
 assert.equal(publicBaseUrl({...codespace,PUBLIC_BASE_URL:'https://delivery.example.ma/path?tab=test'}),'https://delivery.example.ma');
});

test('local startup and invalid deployment configuration never create a wildcard origin',()=>{
 assert.equal(publicBaseUrl({}),'http://localhost:3000');
 assert.equal(publicBaseUrl({PUBLIC_BASE_URL:'http://127.0.0.1:3100'}),'http://127.0.0.1:3100');
 assert.equal(publicBaseUrl({...codespace,CODESPACES:'false'}),'http://localhost:3000');
 assert.equal(publicBaseUrl({...codespace,GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:'app.github.dev/evil'}),'http://localhost:3000');
 for(const value of ['*','javascript:alert(1)','https://name:secret@example.ma'])assert.throws(()=>publicBaseUrl({PUBLIC_BASE_URL:value}),/PUBLIC_BASE_URL/);
});

test('Codespaces browser setup succeeds while foreign origins and forged proxy headers remain rejected',async()=>{
 const expected=publicBaseUrl({...codespace,PUBLIC_BASE_URL:'http://localhost:3000'});
 const {server,db}=buildServer({sameOrigin:expected,sessionSecret:'codespaces-regression-secret-with-32-characters'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,origin,data,extra={})=>fetch(base+path,{method:'POST',headers:{Origin:origin,'X-Requested-With':'delivery-ui','Content-Type':'application/json',...extra},body:JSON.stringify(data)});
  const setup=await post('/api/auth/setup',expected,{companyName:'Codespace Test',fullName:'Hamza',email:'test@example.ma',password:'a-strong-regression-password'});
  assert.equal(setup.status,201);await setup.json();
  const denied=await post('/api/auth/login','https://attacker.example',{email:'test@example.ma',password:'a-strong-regression-password'},{'X-Forwarded-Host':'attacker.example','X-Forwarded-Proto':'https'});
  assert.equal(denied.status,403);assert.equal((await denied.json()).error,'Origine non autorisée');
  const login=await post('/api/auth/login',expected,{email:'test@example.ma',password:'a-strong-regression-password'});
  assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/dn_session=/);await login.json();
 }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});

test('rewritten Codespaces origins require this codespace, exact port and independent browser header',async()=>{
 const {allowedBrowserOrigin}=await import('../src/environment.mjs');
 const expected=publicBaseUrl(codespace),headers={origin:'http://localhost:3000','x-transitflow-origin':expected,'sec-fetch-site':'same-origin'};
 assert.equal(allowedBrowserOrigin(headers,expected,codespace),true);
 assert.equal(allowedBrowserOrigin({...headers,origin:'https://127.0.0.1:3000'},expected,codespace),true);
 assert.equal(allowedBrowserOrigin({...headers,'sec-fetch-site':undefined},expected,codespace),true);
 for(const changes of [{origin:'http://localhost:3001'},{origin:'https://attacker.example'},{'x-transitflow-origin':undefined},{'x-transitflow-origin':'https://other-3000.app.github.dev'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'}])assert.equal(allowedBrowserOrigin({...headers,...changes},expected,codespace),false,JSON.stringify(changes));
 assert.equal(allowedBrowserOrigin(headers,expected,{}),false);
 assert.equal(allowedBrowserOrigin(headers,expected,{...codespace,CODESPACE_NAME:'another-codespace'}),false);
 assert.equal(allowedBrowserOrigin({...headers,'x-transitflow-origin':'https://delivery.example.ma'},'https://delivery.example.ma',codespace),false);
});

test('setup and login work with a rewritten localhost Origin without allowing cross-origin or plain form submissions',async()=>{
 const expected=publicBaseUrl(codespace),{server,db}=buildServer({environment:codespace,sessionSecret:'codespaces-proxy-regression-secret-123456789'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}`,credentials={email:'proxy@example.ma',password:'proxy-regression-password-123'};
  const post=(path,data,extra={})=>fetch(base+path,{method:'POST',headers:{Origin:'http://localhost:3000','X-Requested-With':'delivery-ui','X-TransitFlow-Origin':expected,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',...extra},body:JSON.stringify(data)});
  const setup=await post('/api/auth/setup',{companyName:'Proxy Test',fullName:'Hamza',...credentials});assert.equal(setup.status,201);await setup.json();
  const login=await post('/api/auth/login',credentials);assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/dn_session=/);await login.json();
  const cross=await post('/api/auth/login',credentials,{'Sec-Fetch-Site':'cross-site'});assert.equal(cross.status,403);await cross.json();
  const form=await post('/api/auth/login',credentials,{'X-Requested-With':''});assert.equal(form.status,403);assert.equal((await form.json()).error,'En-tête anti-CSRF requis');
 }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});
