import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { fixture } from './fixture.mjs';
import { createApp } from '../dist/main.js';
import { database, verifyRuntimeRole } from '../dist/db.js';
import { workbook, readWorkbook } from '../dist/documents.js';
import { totpAt } from '../dist/security/crypto.js';

const origin='http://127.0.0.1:3200';
const base='/api/v2';
const sampleOrder={ source:'EXTERNAL',recipient:'Colis QA',phone:'0600000000',address:'12 rue de test',city:'Tanger',codCentimes:20000 };
const scan=(trackingCode,extra={})=>({ trackingCode,method:'MANUAL',confirmed:true,requestKey:randomUUID(),...extra });

test('V2 real PostgreSQL · auth, scan races, stock, custody, finance, handoff, complaint',async t=>{
  assert.ok(process.env.TF_MIGRATION_DATABASE_URL,'Use a local dedicated PostgreSQL service');
  const f=await fixture(process.env.TF_MIGRATION_DATABASE_URL);
  let app;
  t.after(async()=>{await app?.close();await f.close();});
  app=await createApp({origin,databaseUrl:f.runtimeUrl,dataKey:f.dataKey,secure:false,host:'127.0.0.1',port:3100});
  const api=app.getHttpAdapter().getInstance();
  const cookies={};
  async function call(role,method,path,payload,expected=200,headers={}) {
    const response=await api.inject({ method,url:base+path,payload,headers:{
      origin,'x-transitflow-request':'1',...(role?{cookie:cookies[role]}:{}),...headers,
    } });
    if (expected!==null) assert.equal(response.statusCode,expected,`${method} ${path}: ${response.headers['content-type']?.includes('json')?response.body:'non-JSON'}`);
    return { response,body:response.headers['content-type']?.includes('json')?response.json():null };
  }
  async function login(role,withMfa=true) {
    const account=f.accounts[role],totp=account.seed&&withMfa?totpAt(account.seed,Math.floor(Date.now()/30000)):undefined;
    const {response}=await call(null,'POST','/auth/login',{login:account.login,password:account.password,totp},withMfa?200:401);
    if (withMfa) cookies[role]=response.headers['set-cookie'].split(';')[0];
  }
  const [agency,foreignAgency]=f.agencies;
  const [merchant,foreignMerchant]=f.merchants;

  await t.test('origin enforcement, live auth, TOTP, tenant boundaries and DB grants',async()=>{
    await call(null,'GET','/health/ready');
    await call(null,'GET','/orders',undefined,401);
    await call(null,'POST','/auth/login',{login:f.accounts.admin.login,password:f.accounts.admin.password},403,{origin:'https://invalid.test'});
    await login('admin',false);
    for (const role of ['admin','dev','staff','retour','agency','otherAgency','merchant','otherMerchant','finance','collector']) await login(role);
    await login('admin',false);
    await call('agency','GET','/orders?agencyId='+foreignAgency.id,undefined,403);
    await call('merchant','GET','/orders?merchantId='+foreignMerchant.id,undefined,403);
    await call('agency','POST','/orders',sampleOrder,403);
    const runtime=database(f.runtimeUrl);
    try {
      await verifyRuntimeRole(runtime);
      await assert.rejects(runtime.query('UPDATE v2_scan_events SET method=\'MANUAL\''),{code:'42501'});
      await assert.rejects(runtime.query('UPDATE v2_return_bon_lines SET received_at=now()'),{code:'42501'});
      await assert.rejects(runtime.query('UPDATE v2_agency_payment_bons SET paid_at=now()'),{code:'42501'});
      await assert.rejects(runtime.query('TRUNCATE v2_audit_events'),{code:'42501'});
    } finally { await runtime.end(); }
  });

  let external,stock,exchange,bon;
  async function dispatch(rows) {
    const {body}=await call('staff','POST','/dispatch',{agencyId:agency.id,city:'Tanger'},201);
    await call('staff','POST','/dispatch/'+body.id+'/add',{ids:rows.map(o=>o.id)});
    await call('staff','POST','/dispatch/'+body.id+'/state',{action:'SEND'});
    await call('staff','POST','/dispatch/agencies/'+agency.id+'/arrival',{ codes:rows.map(o=>o.tracking_code),confirmed:true });
    return body;
  }
  async function status(row,next,role='staff') {
    return call(role,'POST','/orders/'+row.id+'/correct',{status:next,reason:'Contrôle opérationnel de test'});
  }
  await t.test('stock FIFO shortage, no ticket before availability, printing neutral, pickup and dispatch',async()=>{
    const product=(await call('staff','POST','/stock/products',{merchantId:merchant.id,sku:'QA-01',name:'Stock QA'},201)).body;
    const inputs={...sampleOrder,source:'STOCK',items:[{productId:product.id,quantity:2}]};
    stock=(await call('merchant','POST','/orders',inputs,201)).body;
    assert.equal(stock.status,'MANQUE_STOCK');
    await call('merchant','POST','/tickets',{ids:[stock.id]},409);
    await call('otherMerchant','POST','/orders',inputs,403);
    await call('staff','POST','/stock/products/'+product.id+'/replenish',{quantity:1});
    await call('staff','POST','/stock/products/'+product.id+'/replenish',{quantity:3});
    assert.equal((await f.query('SELECT status FROM v2_orders WHERE id=$1',[stock.id])).status,'ATTENTE_RAMASSAGE');
    const ticket=(await call('merchant','POST','/tickets',{ids:[stock.id]},201)).body;
    const pdf=(await call('merchant','GET','/tickets/'+ticket.id+'/pdf')).response.rawPayload;
    const [label]=(await PDFDocument.load(pdf)).getPages();
    assert.ok(Math.abs(label.getWidth()-100*72/25.4)<0.01);
    assert.equal((await f.query('SELECT status FROM v2_orders WHERE id=$1',[stock.id])).status,'ATTENTE_RAMASSAGE');
    await call('otherMerchant','GET','/tickets/'+ticket.id+'/pdf',undefined,404);
    external=(await call('merchant','POST','/orders',sampleOrder,201)).body;
    exchange=(await call('merchant','POST','/orders',{...sampleOrder,isExchange:true},201)).body;
    const pickup=(await call('merchant','POST','/pickups',{zone:'Tanger',address:'12 rue de test'},201)).body;
    await call('staff','POST','/pickups/'+pickup.id+'/state',{action:'ASSIGN',assigneeId:f.accounts.collector.id});
    await call('collector','POST','/pickups/'+pickup.id+'/state',{action:'PICK'});
    await call('merchant','POST','/pickups/'+pickup.id+'/state',{action:'CANCEL'},409);
    await call('staff','POST','/pickups/'+pickup.id+'/state',{action:'CLOSE'});
    for (const row of [stock,external,exchange]) {
      const request=scan(row.tracking_code);
      await call('staff','POST','/orders/collect',{...request,confirmed:undefined},422);
      const [one,two]=await Promise.all([call('staff','POST','/orders/collect',request),call('staff','POST','/orders/collect',request)]);
      assert.deepEqual([one.body.outcome,two.body.outcome].sort(),['RECEIVED','REPLAY']);
    }
    assert.deepEqual((await f.db.query('SELECT physical,reserved FROM v2_stock_lots WHERE product_id=$1 ORDER BY created_at',[product.id])).rows,
      [{physical:0,reserved:0},{physical:2,reserved:0}]);
    bon=await dispatch([external,stock,exchange]);
    await call('staff','POST','/dispatch/'+bon.id+'/state',{action:'REOPEN'},409);
    await call('otherAgency','GET','/orders/'+stock.id,undefined,404);
    await call('otherMerchant','GET','/orders/'+stock.id,undefined,404);
    assert.equal((await call('agency','GET','/orders')).body.total,3);
    const excel=(await call('merchant','GET','/orders/export?city=Tanger')).response.rawPayload;
    assert.deepEqual((await readWorkbook(excel))[0],['CODE SUIVI','DESTINATAIRE','TELEPHONE','ADRESSE','PRIX','VILLE','COMMENTAIRE','MARCHANDISE','QTY','PEUT OUVRIR','COLIS REMPLACER']);
  });

  let staffReturn,agencyReturn,merchantBon;
  await t.test('agency Excel duplicate, same-city scope, stale lines, race, PDF, stock once',async()=>{
    await status(stock,'REFUSE');
    await status(external,'MISE_EN_DISTRIBUTION');
    const file=await workbook(['CODE SUIVI','NOTE'],[[stock.tracking_code,'1'],[stock.tracking_code,'2'],[external.tracking_code,'3'],['UNKNOWN100','4']]);
    async function upload(role='agency',expected=201) {
      const boundary='tf'+randomUUID();
      const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="returns.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
        file,Buffer.from(`\r\n--${boundary}--\r\n`)]);
      return call(role,'POST','/agencies/'+agency.id+'/return-import',payload,expected,{'content-type':'multipart/form-data; boundary='+boundary});
    }
    agencyReturn=(await upload()).body.bon;
    assert.equal((await upload('agency',409)).body.details.bonId,agencyReturn.id);
    await upload('otherAgency',403);
    await call('staff','POST','/return-bons/'+agencyReturn.id+'/lines',{add:[exchange.tracking_code]},403);
    await call('otherAgency','GET','/return-bons/'+agencyReturn.id,undefined,404);
    await call('agency','DELETE','/return-bons/'+agencyReturn.id,{confirmed:true},204);
    agencyReturn=(await upload()).body.bon;
    staffReturn=(await call('staff','POST','/return-bons',{agencyId:agency.id,codes:[stock.tracking_code,external.tracking_code,exchange.tracking_code]},201)).body.bon;
    await call('agency','POST','/return-bons/'+staffReturn.id+'/lines',{add:[stock.tracking_code]},403);
    await call('staff','POST','/return-bons/'+staffReturn.id+'/lines',{remove:[exchange.tracking_code],confirmed:true});
    const removed=(await call('staff','POST','/return-bons/'+staffReturn.id+'/receive',scan(exchange.tracking_code),409)).body;
    assert.equal(removed.code,'RETURN_CODE_REMOVED');
    await call('agency','POST','/return-bons/'+agencyReturn.id+'/state',{action:'SEND'});
    await call('staff','POST','/return-bons/'+staffReturn.id+'/state',{action:'SEND'});
    const result=await Promise.all([
      call('staff','POST','/return-bons/'+staffReturn.id+'/receive',scan(stock.tracking_code),null),
      call('retour','POST','/return-bons/'+agencyReturn.id+'/receive',scan(stock.tracking_code),null),
    ]);
    assert.deepEqual(result.map(r=>r.response.statusCode).sort(),[200,409]);
    const winner=result[0].response.statusCode===200?staffReturn:agencyReturn;
    await call(winner===staffReturn?'staff':'agency','POST','/return-bons/'+winner.id+'/lines',{add:[exchange.tracking_code]},409);
    assert.equal((await call('agency','GET','/orders')).body.total,2);
    assert.equal((await f.query('SELECT count(*)::int AS count FROM v2_stock_moves WHERE order_id=$1 AND kind=\'RETOUR\'',[stock.id])).count,1);
    const failed=(await call('staff','POST','/return-bons/'+winner.id+'/receive',scan(external.tracking_code),409)).body;
    assert.equal(failed.code,'SCAN_WRONG_STATUS');
    assert.equal(failed.details.orderId,external.id);
    await status(external,'REFUSE');
    const receipt=scan(external.tracking_code,{damaged:true,note:'Emballage écrasé'});
    await call('retour','POST','/return-bons/'+winner.id+'/receive',{...receipt,confirmed:undefined},422);
    assert.equal((await call('retour','POST','/return-bons/'+winner.id+'/receive',receipt)).body.outcome,'RECEIVED');
    assert.equal((await call('retour','POST','/return-bons/'+winner.id+'/receive',receipt)).body.outcome,'REPLAY');
    await call('staff','POST','/return-bons/'+winner.id+'/state',{action:'CLOSE',confirmed:true,receivedCount:2});
    const pdf=(await call('agency','GET','/return-bons/'+winner.id+'/pdf')).response.rawPayload;
    assert.equal((await PDFDocument.load(pdf)).getPageCount(),1);
    assert.equal((await f.query('SELECT status,current_holder_type FROM v2_orders WHERE id=$1',[external.id])).status,'REFUSE');
    assert.equal((await f.query('SELECT count(*)::int AS count FROM v2_scan_events WHERE evidence=\'UNVERIFIED\' AND bon_id=$1',[winner.id])).count,2);
  });

  await t.test('signed partner mapping, immediate COD, replays, paid immutability and finance restriction',async()=>{
    const secret='fake-partner-secret-for-deterministic-tests-only';
    await call('dev','PUT','/developer/partners/'+agency.id+'/secret',{secret});
    const occurredAt=new Date().toISOString();
    const body={id:'paid-1',trackingCode:exchange.tracking_code,externalStatus:'ACCEPTED_BY_BUYER',occurredAt};
    const ts=String(Math.floor(Date.now()/1000));
    const signature=createHmac('sha256',secret).update([ts,body.id,body.trackingCode,body.externalStatus,body.occurredAt].join('\n')).digest('hex');
    const headers={'x-tf-timestamp':ts,'x-tf-signature':'sha256='+signature};
    await call(null,'POST','/partner/'+agency.id+'/events',body,401);
    assert.equal((await call(null,'POST','/partner/'+agency.id+'/events',body,202,headers)).body.outcome,'UNMAPPED');
    await call('dev','PUT','/developer/partners/'+agency.id+'/mapping',{externalStatus:body.externalStatus,status:'LIVRE',reason:'Validation de mapping QA'});
    assert.equal((await call(null,'POST','/partner/'+agency.id+'/events',body,200,headers)).body.outcome,'REPLAY');
    const available=(await call('merchant','GET','/finance/merchant')).body;
    assert.equal(Number(available.balance_centimes),16100);
    const agencyBon=(await call('staff','POST','/finance/agencies/'+agency.id+'/bons',{all:true},201)).body;
    assert.equal(Number(agencyBon.expected_centimes),20000);
    const first={amount:15000,requestKey:randomUUID()};
    await call('staff','POST','/finance/agency-bons/'+agencyBon.id+'/remittance',first);
    await call('staff','POST','/finance/agency-bons/'+agencyBon.id+'/remittance',first);
    const pending=(await call('staff','GET','/finance/agency-bons/'+agencyBon.id)).body.bon;
    assert.equal(pending.status,'EN_COURS_TRAITEMENT');
    assert.equal(Number(pending.outstanding_centimes),5000);
    await call('staff','POST','/finance/agency-bons/'+agencyBon.id+'/confirm-paid',{confirmed:true},403);
    await call('dev','POST','/finance/agency-bons/'+agencyBon.id+'/confirm-paid',{confirmed:true},403);
    await call('finance','POST','/finance/agency-bons/'+agencyBon.id+'/confirm-paid',{confirmed:true},409);
    const invoice=(await call('admin','POST','/finance/merchant/'+merchant.id+'/invoices',{ids:[exchange.id]},201)).body;
    assert.equal(Number(invoice.total_centimes),16100);
    await call('admin','POST','/finance/invoices/'+invoice.id+'/pay',{method:'ESPECES',confirmed:true});
    await call('staff','POST','/finance/agency-bons/'+agencyBon.id+'/remittance',{amount:5000,requestKey:randomUUID()});
    await call('finance','POST','/finance/agency-bons/'+agencyBon.id+'/confirm-paid',{confirmed:true});
    await call('dev','PUT','/developer/partners/'+agency.id+'/mapping',{externalStatus:body.externalStatus,status:'REFUSE',reason:'Échange livré protégé'});
    assert.equal((await f.query('SELECT status FROM v2_orders WHERE id=$1',[exchange.id])).status,'LIVRE');
    assert.equal((await f.query('SELECT status FROM v2_agency_payment_bons WHERE id=$1',[agencyBon.id])).status,'PAYE');
    assert.equal(Number((await call('merchant','GET','/finance/merchant')).body.balance_centimes),0);
  });

  await t.test('merchant handoff and scope, group notification, immutable complaint chat',async()=>{
    merchantBon=(await call('retour','POST','/merchant-returns',{merchantId:merchant.id},201)).body;
    assert.equal((await call('retour','POST','/merchant-returns/'+merchantBon.id+'/add',{all:true})).body.added,1);
    assert.equal((await call('retour','POST','/merchant-returns/'+merchantBon.id+'/add',{all:true})).body.added,0);
    const document=(await call('retour','GET','/merchant-returns/'+merchantBon.id+'/pdf')).response.rawPayload;
    assert.equal((await PDFDocument.load(document)).getPageCount(),2);
    await call('otherMerchant','GET','/merchant-returns/'+merchantBon.id,undefined,404);
    await call('retour','POST','/merchant-returns/'+merchantBon.id+'/state',{action:'SEND'});
    await call('retour','POST','/merchant-returns/'+merchantBon.id+'/state',{action:'RECEIVE',confirmed:true});
    assert.equal((await call('merchant','GET','/notifications')).body.unread,1);
    await call('otherMerchant','POST','/merchant-returns/'+merchantBon.id+'/state',{action:'CONFIRM',confirmed:true},404);
    await call('merchant','POST','/merchant-returns/'+merchantBon.id+'/state',{action:'CONFIRM',confirmed:true});
    await call('admin','POST','/merchant-returns/'+merchantBon.id+'/state',{action:'EXCEPTIONAL_REOPEN',reason:'Test'},409);
    const input={topic:'RETURN',referenceId:merchantBon.id,subject:'Contrôle colis',message:'Bonjour, colis endommagé.',parcels:[external.id]};
    const claim=(await call('merchant','POST','/claims',input,201)).body;
    await call('merchant','POST','/claims',input,409);
    await call('otherMerchant','GET','/claims/'+claim.id,undefined,404);
    await call('retour','POST','/claims/'+claim.id+'/state',{action:'CLAIM'});
    await call('staff','POST','/claims/'+claim.id+'/messages',{body:'Analyse interne',privateNote:true});
    await call('retour','POST','/claims/'+claim.id+'/messages',{body:'Nous avons reçu votre message.'});
    assert.equal((await call('merchant','GET','/claims/'+claim.id)).body.messages.length,2);
    await call('retour','POST','/claims/'+claim.id+'/state',{action:'CLOSE'});
    for (let i=0;i<3;i++) {
      await call('merchant','POST','/claims/'+claim.id+'/state',{action:'REOPEN'});
      await call('retour','POST','/claims/'+claim.id+'/state',{action:'CLOSE'});
    }
    await call('merchant','POST','/claims/'+claim.id+'/state',{action:'REOPEN'},409);
  });
  await t.test('100 concurrent authenticated API requests and revoked session',async()=>{
    await app.listen(0,'127.0.0.1');
    const address=api.server.address();
    const times=await Promise.all(Array.from({length:100},async()=>{
      const start=performance.now();
      const response=await fetch('http://127.0.0.1:'+address.port+base+'/orders',{headers:{cookie:cookies.staff}});
      assert.equal(response.status,200);
      await response.arrayBuffer();
      return performance.now()-start;
    }));
    times.sort((a,b)=>a-b);
    t.diagnostic('p95 /orders, 100 concurrent requests with a shared test session and small synthetic dataset: '+times[94].toFixed(1)+' ms');
    await call('staff','POST','/auth/logout',{},204);
    await call('staff','GET','/orders',undefined,401);
  });
});
