/* Real browser → API → SQLite journeys. Playwright is a CI-only dependency. */
const assert=require('node:assert/strict');
const {mkdirSync,writeFileSync}=require('node:fs');
const {chromium}=require('playwright');
const password='browser-journey-password-2026';
const evidence='browser-evidence';
const errors=[];
const contexts=[];
let browser,server,db,currentPage;
const base='http://127.0.0.1:3188';
async function eventually(read,expected,label){
 const end=Date.now()+10000;let value;
 while(Date.now()<end){value=await read();if(typeof expected==='function'?expected(value):value===expected)return value;await new Promise(r=>setTimeout(r,50));}
 assert.fail(`${label}: ${JSON.stringify(value)} (expected ${expected})`);
}
async function request(context,path,data,method=data===undefined?'GET':'POST'){
 const response=await context.request.fetch(base+'/api'+path,{method,data,headers:{'X-Requested-With':'delivery-ui'}});
 const value=await response.json();assert.ok(response.ok(),`${method} ${path}: ${response.status()} ${JSON.stringify(value)}`);return value;
}
async function account(admin,role,merchantId,agencyId){
 const email=role.toLowerCase()+'@browser.ma';
 const value=await request(admin,'/users',{name:role+' Browser',email,password,role,merchantId,agencyId});return {id:value.id,email};
}
async function session(email,tab='dashboard',mobile=false){
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},acceptDownloads:true});contexts.push(context);
 if(email)await request(context,'/auth/login',{email,password});
 const page=await context.newPage();currentPage=page;
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('response',r=>{if(r.url().startsWith(base)&&r.status()>=500)errors.push(`${r.status()} ${r.url()}`);});
 await page.goto(base+'/?tab='+tab);await page.locator('.shell').waitFor();return {context,page};
}
async function go(page,tab){currentPage=page;await page.goto(base+'/?tab='+tab);await page.locator('.shell').waitFor();}
async function click(page,selector){await page.locator(selector).click();}
async function save(page,name){currentPage=page;await page.screenshot({path:`${evidence}/${name}.png`,fullPage:true});}
async function submit(page){
 const dialog=page.getByRole('dialog');await dialog.locator('button[type="submit"]').click();await dialog.waitFor({state:'detached'});
}
async function fill(page,fields){for(const [name,value] of Object.entries(fields))await page.getByRole('dialog').locator(`[name="${name}"]`).fill(String(value));}
async function choose(page,fields){for(const [name,value] of Object.entries(fields))await page.getByRole('dialog').locator(`[name="${name}"]`).selectOption(String(value));}
async function open(page,kind,id){await click(page,`[data-action="wf-view"][data-kind="${kind}"][data-id="${id}"]`);await page.locator('[data-action="wf-back"]').waitFor();}
async function scan(page,form,value){await page.locator(`${form} input[name="scan"]`).fill(value);await page.locator(`${form} button[type="submit"]`).click();}
function shipment(tracking){return db.prepare('SELECT * FROM shipments WHERE tracking=?').get(tracking);}
function state(table,id){return db.prepare(`SELECT state FROM ${table} WHERE id=?`).get(id)?.state;}
async function run(){
 mkdirSync(evidence,{recursive:true});
 const {buildServer}=await import('../src/server.mjs');const {openDb}=await import('../src/db.mjs');
 db=openDb(':memory:');({server}=buildServer({db,sessionSecret:'browser-secret-for-isolated-ci-only-123456789',sameOrigin:base}));
 await new Promise(r=>server.listen(3188,'127.0.0.1',r));
 browser=await chromium.launch({headless:true});
 const admin=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});contexts.push(admin);
 const setup=await admin.newPage();currentPage=setup;setup.on('pageerror',e=>errors.push(String(e)));
 await setup.goto(base);await setup.locator('#companyName').fill('Atlas Livraison QA');await setup.locator('#fullName').fill('Direction Browser');await setup.locator('#email').fill('admin@browser.ma');await setup.locator('#password').fill(password);await setup.locator('#auth-form button').click();
 await setup.getByRole('button',{name:'Se connecter →'}).waitFor();await setup.locator('#email').fill('admin@browser.ma');await setup.locator('#password').fill(password);await setup.locator('#auth-form button').click();await setup.locator('.shell').waitFor();
 const tanger=await request(admin,'/agencies',{name:'Agence Tanger',city:'Tanger',fee:20,kind:'PARTNER'});
 await request(admin,'/agencies',{name:'Hub Casa',city:'Casablanca',fee:0,kind:'INTERNAL'});
 const merchant=await request(admin,'/merchants',{name:'Boutique Atlas',phone:'0612345678'});
 const people={};
 for(const role of ['OPERATIONS','DISPATCHER','WAREHOUSE','PICKUP_DRIVER','AGENCY_MANAGER','AGENCY_AGENT','DRIVER','SUPPORT','FINANCE','MERCHANT'])people[role]=await account(admin,role,role==='MERCHANT'?merchant.id:undefined,['AGENCY_MANAGER','AGENCY_AGENT','DRIVER'].includes(role)?tanger.id:undefined);
 const vehicle=await request(admin,'/workflow/vehicles',{plate:'11111-A-6',kind:'CAR',ownership:'DRIVER',driverId:people.PICKUP_DRIVER.id});
 const product=await request(admin,'/inventory/products',{sku:'BROWSER-SKU',name:'Produit marchand',merchantId:merchant.id});
 await request(admin,'/inventory/receive',{productId:product.id,quantity:10,location:'A-01'});
 console.log('Bootstrap UI and 11 account roles ready');

 // A merchant creates both sources through the real form.
 const m=await session(people.MERCHANT.email,'shipments');
 const tracks=[];
 for(const source of ['EXTERNAL','STOCK']){
  await m.page.locator('[data-action="new-shipment"]').first().click();await choose(m.page,{source,city:'Tanger'});
  await fill(m.page,{recipient:source+' Client',phone:'0612345678',address:'Rue Test 12',cod:200,description:'Commande '+source});
  if(source==='STOCK'){await choose(m.page,{productId:product.id});await fill(m.page,{quantity:2});}
  await submit(m.page);await eventually(()=>db.prepare('SELECT tracking FROM shipments WHERE description=?').get('Commande '+source)?.tracking,v=>Boolean(v),'created '+source);tracks.push(db.prepare('SELECT tracking FROM shipments WHERE description=?').get('Commande '+source).tracking);
 }
 const [external,stock]=tracks;assert.equal(db.prepare("SELECT SUM(quantity) n FROM stock_allocations WHERE state='RESERVED'").get().n,2);
 await go(m.page,'pickups');await click(m.page,'[data-action="wf-point"]');await fill(m.page,{label:'Boutique Casa',contactName:'Marchand',phone:'0612345678',city:'Casablanca',address:'Rue Marchand 5'});await submit(m.page);
 await click(m.page,'[data-action="wf-new"][data-kind="pickups"]');await m.page.getByRole('dialog').locator('input[name="shipmentIds"]').check();await submit(m.page);
 const pickup=db.prepare('SELECT * FROM pickups').get();await eventually(()=>m.page.locator('[data-action="wf-back"]').count(),1,'pickup detail');await save(m.page,'01-merchant-pickup');
 await go(m.page,'claims');await click(m.page,'[data-action="wf-new"][data-kind="claims"]');await fill(m.page,{tracking:external,subject:'Suivi de mon colis',message:'Merci de confirmer le passage du ramasseur'});await submit(m.page);
 const claim=db.prepare('SELECT * FROM claims').get();await m.page.locator('#claim-file').setInputFiles({name:'preuve.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nTest\n%%EOF')});await m.page.locator('#claim-upload button').click();await eventually(()=>db.prepare('SELECT COUNT(*) n FROM claim_attachments').get().n,1,'private attachment');

 // Dispatcher assigns the personal vehicle. Pickup driver confirms collection only.
 const a=await session('admin@browser.ma','pickups');await open(a.page,'pickups',pickup.id);await click(a.page,'[data-action="wf-assign"]');await choose(a.page,{driverId:people.PICKUP_DRIVER.id});await choose(a.page,{vehicleId:vehicle.id});await submit(a.page);
 const p=await session(people.PICKUP_DRIVER.email,'pickups',true);await open(p.page,'pickups',pickup.id);await click(p.page,'[data-kind="pickups/start"]');await p.page.locator('[data-workflow-scan="pickups"]').waitFor();await scan(p.page,'[data-workflow-scan="pickups"]',external);
 await eventually(()=>shipment(external).status,'COLLECTED','merchant collection');await click(p.page,'[data-action="wf-complete-pickup"]');await fill(p.page,{receiverName:'Marchand Atlas'});await submit(p.page);await save(p.page,'02-pickup-driver-mobile');
 const w=await session(people.WAREHOUSE.email,'operations');
 for(const tracking of tracks){await scan(w.page,'#pickup-scan',tracking);await eventually(()=>shipment(tracking).status,'PICKED_UP','warehouse '+tracking);await w.page.locator('#pickup-scan button:not([disabled])').waitFor();}
 assert.equal(state('pickups',pickup.id),'RECEIVED');assert.equal(db.prepare("SELECT SUM(quantity_on_hand) n FROM stock_lots WHERE product_id=?").get(product.id).n,8);
 await save(w.page,'03-warehouse');

 // Physical city container, XLSX and departure are separate operations.
 await go(a.page,'dispatches');await click(a.page,`[data-action="new-container"][data-id="${tanger.id}"]`);await a.page.locator('#container-scan').waitFor();const dispatch=db.prepare('SELECT * FROM dispatches').get();
 for(const tracking of tracks){await scan(a.page,'#container-scan',tracking);await a.page.locator('#container-scan button:not([disabled])').waitFor();await eventually(()=>db.prepare('SELECT scanned_at FROM dispatch_items WHERE shipment_id=?').get(shipment(tracking).id)?.scanned_at,v=>Boolean(v),'container scan');}
 await click(a.page,'[data-action="close-container"]');await a.page.locator('[data-action="export-container"]').waitFor();
 const downloadPromise=a.page.waitForEvent('download');await click(a.page,'[data-action="export-container"]');const download=await downloadPromise;assert.match(download.suggestedFilename(),/\.xlsx$/);await download.saveAs(`${evidence}/envoi-tanger.xlsx`);
 await click(a.page,'[data-action="ship-container"]');await eventually(()=>state('dispatches',dispatch.id),'SHIPPED','physical departure');
 const agency=await session(people.AGENCY_AGENT.email,'arrivals');await open(agency.page,'arrivals',dispatch.id);
 for(const tracking of tracks){await scan(agency.page,'[data-workflow-scan="arrivals"]',tracking);await eventually(()=>shipment(tracking).status,'AT_AGENCY','agency reception');await agency.page.locator('[data-workflow-scan="arrivals"] button:not([disabled])').waitFor();}
 await save(agency.page,'04-agency-arrival');

 // A route records proof/COD for one stop and a refusal for the other.
 await go(a.page,'routes');await click(a.page,'[data-action="wf-new"][data-kind="routes"]');await choose(a.page,{agencyId:tanger.id});await choose(a.page,{driverId:people.DRIVER.id});await eventually(()=>a.page.getByRole('dialog').locator('input[name="shipmentIds"]').count(),2,'route eligible parcels');for(const check of await a.page.getByRole('dialog').locator('input[name="shipmentIds"]').all())await check.check();await submit(a.page);
 const route=db.prepare('SELECT * FROM delivery_routes').get();const d=await session(people.DRIVER.email,'routes',true);await open(d.page,'routes',route.id);await click(d.page,'[data-kind="routes/start"]');await eventually(()=>state('delivery_routes',route.id),'ACTIVE','start route');await d.page.locator(`[data-action="wf-attempt"][data-id="${shipment(external).id}"]`).waitFor();
 await click(d.page,`[data-action="wf-attempt"][data-id="${shipment(external).id}"]`);await fill(d.page,{receiverName:'Client Livraison',collectedAmount:200});await submit(d.page);
 await click(d.page,`[data-action="wf-attempt"][data-id="${shipment(stock).id}"]`);await choose(d.page,{result:'REFUSED'});await fill(d.page,{note:'Client refuse le produit reçu'});await submit(d.page);await click(d.page,'[data-kind="routes/close"]');await eventually(()=>state('delivery_routes',route.id),'CLOSED','close route');await save(d.page,'05-driver-mobile');

 // Stock returns pass physical receipt and QC before increasing sellable stock.
 await go(m.page,'returns');await click(m.page,'[data-action="wf-new"][data-kind="returns"]');await fill(m.page,{tracking:stock,reason:'Refus du client, récupérer les produits'});await submit(m.page);const ret=db.prepare('SELECT * FROM parcel_returns').get();
 await go(a.page,'returns');await open(a.page,'returns',ret.id);await click(a.page,'[data-action="wf-authorize"]');await fill(a.page,{note:'Retour warehouse autorisé'});await submit(a.page);await click(a.page,'[data-action="wf-ship-return"]');await fill(a.page,{proofReference:'BON-RETOUR-001'});await submit(a.page);await click(a.page,'[data-action="wf-receive-return"]');await fill(a.page,{scan:stock});await submit(a.page);
 assert.equal(db.prepare('SELECT SUM(quantity_on_hand) n FROM stock_lots WHERE product_id=?').get(product.id).n,8);
 await click(a.page,'[data-action="wf-inspect-return"]');await choose(a.page,{disposition:'RESTOCK'});await fill(a.page,{note:'Deux produits scellés conformes'});await submit(a.page);await click(a.page,'[data-action="wf-complete-return"]');await submit(a.page);assert.equal(state('parcel_returns',ret.id),'COMPLETED');assert.equal(db.prepare('SELECT SUM(quantity_on_hand) n FROM stock_lots WHERE product_id=?').get(product.id).n,10);await save(a.page,'06-return-qc');

 // A declaration never credits the merchant until finance reconciles the remittance.
 await go(d.page,'cash');await click(d.page,'[data-action="wf-remittance"]');await fill(d.page,{proofReference:'CAISSE-LIVREUR-001'});await submit(d.page);const remit=db.prepare('SELECT * FROM cash_remittances').get();assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger').get().n,0);
 const f=await session(people.FINANCE.email,'cash');await click(f.page,`[data-action="wf-reconcile"][data-id="${remit.id}"]`);await fill(f.page,{receivedAmount:200,note:'Espèces comptées et reçues'});await submit(f.page);assert.equal(state('cash_remittances',remit.id),'RECONCILED');assert.equal(db.prepare('SELECT amount_centimes FROM ledger').get().amount_centimes,20000);await save(f.page,'07-finance');

 const support=await session(people.SUPPORT.email,'claims');await open(support.page,'claims',claim.id);await support.page.locator('#claim-message').fill('Observation interne confidentielle');await support.page.locator('[name="internal"]').check();await support.page.locator('#claim-reply button').click();await eventually(()=>db.prepare('SELECT COUNT(*) n FROM claim_messages WHERE internal=1').get().n,1,'internal note');await support.page.locator('#claim-reply button:not([disabled])').waitFor();await support.page.locator('#claim-message').fill('Votre colis a été livré, merci de votre confiance');await support.page.locator('#claim-reply button').click();await eventually(()=>db.prepare('SELECT COUNT(*) n FROM claim_messages WHERE internal=0').get().n,2,'public support reply');await support.page.locator('#claim-reply button:not([disabled])').waitFor();await click(support.page,'[data-action="wf-claim-status"]');await choose(support.page,{state:'RESOLVED'});await fill(support.page,{note:'Livraison et suivi confirmés'});await submit(support.page);await save(support.page,'08-support');
 await go(m.page,'claims');await open(m.page,'claims',claim.id);await m.page.getByText('Votre colis a été livré, merci de votre confiance',{exact:true}).waitFor();assert.equal(await m.page.getByText('Observation interne confidentielle',{exact:true}).count(),0);
 await m.page.goto(base+'/merchant.html');await m.page.locator('#merchant-app .portal').waitFor();await save(m.page,'09-merchant-portal');

 // Every role loads every visible workspace without a forbidden API or JS error.
 for(const [role,person] of Object.entries(people)){
  const smoke=await session(person.email);const tabs=await smoke.page.locator('.nav [data-tab]').evaluateAll(xs=>xs.map(x=>x.dataset.tab));
  for(const tab of tabs){await go(smoke.page,tab);assert.equal(await smoke.page.locator('#auth-form').count(),0,role+' '+tab);assert.ok((await smoke.page.locator('main.content').innerText()).length>0,role+' '+tab);}
  if(role==='DRIVER')assert.ok(await smoke.page.locator('.nav [data-tab="cash"]').count());console.log(role+': '+tabs.length+' workspaces loaded');await smoke.context.close();
 }
 await p.page.setViewportSize({width:390,height:844});await go(p.page,'pickups');assert.ok(await p.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile page must not overflow');
 assert.deepEqual(errors,[],'browser/server errors');
 writeFileSync(`${evidence}/result.json`,JSON.stringify({ok:true,roles:11,journey:['merchant orders','pickup','warehouse','city dispatch and XLSX','agency arrival','delivery/refusal','return QC','cash reconciliation','claims and privacy'],errors},null,2));console.log('PASS: complete UI → API → database journeys, 11 roles, mobile and desktop');
}
run().catch(async error=>{console.error(error);try{if(currentPage)await save(currentPage,'failure');}catch{}writeFileSync(`${evidence}/failure.txt`,String(error.stack||error)+'\n'+errors.join('\n'));process.exitCode=1;}).finally(async()=>{for(const c of contexts)await c.close().catch(()=>{});if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));if(db)db.close();});
