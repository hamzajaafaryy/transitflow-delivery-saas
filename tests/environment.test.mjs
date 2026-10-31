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
