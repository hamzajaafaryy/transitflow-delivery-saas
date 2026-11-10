import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { preview } from './run.mjs';
import { code128Svg } from '../../src/ticket.mjs';

const require=createRequire(import.meta.url);
const { chromium }=require('playwright');

// Chromium loops a Y4M feed, simulating a parcel held in front of the camera.
async function barcodeVideo(path,tracking) {
  const svg=code128Svg(tracking);
  const width=640,height=480;
  const barcodeWidth=Number(svg.match(/viewBox="0 0 (\d+) 65"/)?.[1]);
  const scale=Math.floor((width-70)/barcodeWidth);
  const left=Math.floor((width-barcodeWidth*scale)/2);
  const luminance=Buffer.alloc(width*height,235);
  for (const match of svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="65"\/>/g)) {
    const barStart=left+Number(match[1])*scale,barEnd=barStart+Number(match[2])*scale;
    for (let y=132;y<338;y++) luminance.fill(16,y*width+barStart,y*width+barEnd);
  }
  const chroma=Buffer.alloc(width*height/2,128);
  const frame=Buffer.concat([Buffer.from('FRAME\n'),luminance,chroma]);
  await writeFile(path,Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`),frame,frame,frame]));
}

test('V2 production Preview in Chromium · staff receipt and mobile merchant confirmation',async t=>{
  const server=await preview({test:true});
  let browser,media;
  t.after(async()=>{await browser?.close();await server.close();if(media) await rm(media,{recursive:true,force:true});});
  media=await mkdtemp(join(tmpdir(),'tf-v2-camera-'));
  const video=join(media,'barcode.y4m');
  await barcodeVideo(video,server.scenario.receivedReturnCode);
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||undefined,
    args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-video-capture='+video]});
  const directory=process.env.TF_BROWSER_EVIDENCE_DIR??'browser-evidence/v2';
  await mkdir(directory,{recursive:true});
  const faults=[];
  async function open(profile,viewport={width:1440,height:1000}) {
    const mobile=viewport.width<600;
    const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,acceptDownloads:true,serviceWorkers:'block'});
    await context.addInitScript(()=>{
      window.scanTones=[];
      const start=OscillatorNode.prototype.start;
      OscillatorNode.prototype.start=function(...args){
        window.scanTones.push(this.frequency.value);
        return start.apply(this,args);
      };
    });
    const page=await context.newPage();
    page.on('pageerror',error=>faults.push(String(error)));
    page.on('response',response=>{
      if (response.status()>=500 && !response.headers()['x-transitflow-fixture']) faults.push(response.status()+' '+new URL(response.url()).pathname);
    });
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
  const desktop=await open('staff');
  await desktop.screenshot({path:directory+'/01-dashboard-desktop.png',fullPage:true,animations:'disabled'});
  const staff=await open('staff',{width:375,height:812});
  const fits=page=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
  const quick=staff.getByRole('navigation',{name:'Navigation rapide'});
  await quick.getByRole('button',{name:'Colis',exact:true}).click();
  await staff.getByRole('heading',{name:'Commandes',exact:true,level:1}).waitFor();
  assert.ok(await fits(staff),'Mobile order cards fit the screen');
  const filter=staff.getByRole('button',{name:'Filtres',exact:true});
  const statusFilter=staff.locator('.mobile-filters .filter-fields').getByRole('combobox').first();
  await filter.click();
  assert.equal(await filter.getAttribute('aria-expanded'),'true');
  await statusFilter.waitFor({timeout:8000});
  await filter.click();
  assert.equal(await statusFilter.isVisible(),false);
  await quick.getByRole('button',{name:'Retours',exact:true}).click();
  await staff.getByRole('button',{name:'Ouvrir',exact:true}).first().click();
  await staff.getByText('Liste verrouillée',{exact:true}).waitFor();
  await staff.getByRole('button',{name:'Recevoir des colis',exact:true}).click();
  const scanner=staff.getByRole('region',{name:'Réception au warehouse'});
  await scanner.waitFor();
  await staff.setViewportSize({width:320,height:720});
  assert.ok(await fits(staff),'Staff scan fits a 320px phone');
  await staff.setViewportSize({width:375,height:812});

  const camera=scanner.getByRole('button',{name:'Scanner avec la caméra'});
  const soundTest=scanner.getByRole('button',{name:'Tester le son'});
  await soundTest.click();
  await staff.waitForFunction(()=>window.scanTones.length===2);
  assert.deepEqual(await staff.evaluate(()=>window.scanTones),[720,980]);
  let cameraCalls=0;
  staff.on('request',request=>{
    if (request.method()==='POST' && request.url().endsWith('/receive') && request.postDataJSON()?.method==='CAMERA') cameraCalls++;
  });
  await camera.click();
  await scanner.locator('.scan-result.duplicate').getByText('Déjà scanné',{exact:true}).waitFor({timeout:10000});
  // This exceeds the old 1.8 second timer while the same code remains in view.
  await setTimeout(2400);
  assert.equal(cameraCalls,1);
  assert.deepEqual((await staff.evaluate(()=>window.scanTones)).slice(-2),[390,390]);
  assert.ok(await staff.evaluate(()=>document.activeElement?.tagName!=='INPUT'),'Camera scan does not open the keyboard');
  await scanner.getByRole('button',{name:'Fermer la caméra'}).click();

  await staff.context().setOffline(true);
  await scanner.getByText('Hors ligne',{exact:true}).waitFor();
  assert.equal(await camera.isEnabled(),false);
  await staff.context().setOffline(false);
  await scanner.getByText('En ligne',{exact:true}).waitFor();

  const attempts=[];
  await staff.route('**/return-bons/*/receive',async route=>{
    const input=route.request().postDataJSON();
    if (input.method==='MANUAL') attempts.push(input);
    if (attempts.length===1) {
      await route.fulfill({status:503,headers:{'x-transitflow-fixture':'retry'},
        json:{code:'RETRY',message:'Réponse temporairement indisponible.'}});
    } else await route.continue();
  });
  await scanner.getByLabel('Code de suivi à scanner').fill(server.scenario.returnCode.toLowerCase());
  await scanner.getByRole('button',{name:'Valider la saisie'}).click();
  await staff.getByText('Vous confirmez la réception de ce colis sans scan physique.',{exact:false}).waitFor();
  assert.equal(attempts.length,0);
  await staff.getByRole('button',{name:'Confirmer sous ma responsabilité'}).click();
  const failure=scanner.locator('.scan-result.error');
  await failure.getByRole('button',{name:'Réessayer ce code'}).waitFor();
  assert.deepEqual((await staff.evaluate(()=>window.scanTones)).slice(-2),[470,280]);
  await failure.getByRole('button',{name:'Réessayer ce code'}).click();
  await scanner.locator('.scan-result.success').getByText('Colis enregistré.',{exact:true}).waitFor();
  assert.equal(attempts.length,2);
  assert.deepEqual(attempts[0],attempts[1]);
  assert.ok(attempts[0].confirmed);
  assert.deepEqual((await staff.evaluate(()=>window.scanTones)).slice(-2),[720,980]);
  assert.ok(await fits(staff),'Scan feedback fits mobile width');
  await staff.screenshot({path:directory+'/05-mobile-operator-scan.png',animations:'disabled'});
  await scanner.getByRole('button',{name:'Son activé'}).click();
  await staff.getByRole('button',{name:'Fermer le scan'}).click();
  await staff.getByRole('button',{name:'Recevoir des colis',exact:true}).click();
  await scanner.getByRole('button',{name:'Son coupé'}).waitFor();
  assert.equal(await soundTest.isEnabled(),false);
  await scanner.getByText('Prêt à scanner',{exact:true}).waitFor();
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
