import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { preview } from './run.mjs';

const require=createRequire(import.meta.url);
const { chromium }=require('playwright');

test('V2 production Preview in Chromium · staff receipt and mobile merchant confirmation',async t=>{
  const server=await preview({test:true});
  let browser;
  t.after(async()=>{await browser?.close();await server.close();});
  browser=await chromium.launch({headless:true,...process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']}:{}});
  const directory=process.env.TF_BROWSER_EVIDENCE_DIR??'browser-evidence/v2';
  await mkdir(directory,{recursive:true});
  const faults=[];
  async function open(profile,viewport={width:1440,height:1000}) {
    const context=await browser.newContext({viewport,acceptDownloads:true});
    const page=await context.newPage();
    page.on('pageerror',error=>faults.push(String(error)));
    page.on('response',response=>{if (response.status()>=500) faults.push(response.status()+' '+new URL(response.url()).pathname);});
    page.on('dialog',dialog=>void dialog.accept());
    const response=await page.goto(server.origin);
    assert.equal(response.headers()['x-frame-options'],'DENY');
    assert.ok(response.headers()['content-security-policy'].includes("frame-ancestors 'none'"));
    await page.getByLabel('Adresse de connexion').fill(server.profiles[profile].login);
    await page.getByLabel('Mot de passe',{exact:true}).fill(server.profiles[profile].password);
    const start=performance.now();
    await page.getByRole('button',{name:'Se connecter',exact:true}).click();
    await page.getByRole('heading',{name:'Vue d’ensemble',exact:true}).waitFor();
    await page.locator('.stat strong').first().filter({hasText:/\d/}).waitFor();
    t.diagnostic(profile+' login to dashboard with data in Chromium: '+(performance.now()-start).toFixed(1)+' ms');
    return page;
  }
  const staff=await open('staff');
  await staff.screenshot({path:directory+'/01-dashboard-desktop.png',fullPage:true,animations:'disabled'});
  await staff.getByRole('navigation').getByRole('button',{name:'Retours agence',exact:true}).click();
  await staff.getByRole('button',{name:'Ouvrir',exact:true}).first().click();
  await staff.getByText('Liste verrouillée',{exact:true}).waitFor();
  await staff.getByRole('button',{name:'Recevoir des colis',exact:true}).click();
  await staff.getByLabel('Code de suivi à scanner').fill(server.scenario.returnCode);
  await staff.getByRole('button',{name:'Valider la saisie'}).click();
  await staff.getByText('Vous confirmez la réception de ce colis sans scan physique.',{exact:false}).waitFor();
  await staff.getByRole('button',{name:'Confirmer sous ma responsabilité'}).click();
  await staff.getByText('Colis enregistré.',{exact:true}).waitFor();
  await staff.getByRole('button',{name:'Clôturer reçu'}).click();
  const download=staff.waitForEvent('download');
  await staff.getByRole('link',{name:'Télécharger PDF A4'}).click();
  assert.match((await download).suggestedFilename(),/^retour-agence-.*\.pdf$/);
  await staff.screenshot({path:directory+'/02-return-closure.png',fullPage:true,animations:'disabled'});

  const merchant=await open('merchant',{width:390,height:844});
  assert.ok(await merchant.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Dashboard fits mobile width');
  await merchant.screenshot({path:directory+'/03-mobile-merchant.png',fullPage:true,animations:'disabled'});
  await merchant.getByRole('button',{name:'Notifications',exact:true}).click();
  await merchant.getByRole('button',{name:/Un bon de retour attend votre confirmation/}).click();
  await merchant.getByRole('button',{name:'Confirmer ce bon'}).click();
  await merchant.getByText('Confirmé par marchand',{exact:true}).waitFor();
  assert.ok(await merchant.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Return details fit mobile width');
  await merchant.screenshot({path:directory+'/04-mobile-confirmation.png',fullPage:true,animations:'disabled'});
  await merchant.getByRole('button',{name:'Se déconnecter'}).click();
  await merchant.getByRole('heading',{name:'Se connecter',exact:true}).waitFor();
  assert.equal((await merchant.request.get(server.origin+'/api/v2/orders')).status(),401);

  const agency=await open('agency');
  await agency.getByRole('navigation').getByRole('button',{name:'Stock Colis',exact:true}).click();
  await agency.getByRole('columnheader',{name:'Dernier scan'}).waitFor();
  assert.equal(await agency.getByRole('columnheader',{name:'Destinataire'}).count(),0);
  assert.equal(await agency.getByText(server.scenario.returnCode,{exact:true}).count(),0);
  assert.equal(await agency.getByRole('navigation').getByRole('button',{name:'Finance',exact:true}).count(),0);
  assert.deepEqual(faults,[]);
});
