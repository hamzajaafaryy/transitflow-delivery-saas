import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../api/dist/main.js';
import { codespacesOrigin } from '../api/dist/config.js';
import { fixture } from '../api/tests/fixture.mjs';
import { localPostgres } from './local-postgres.mjs';
import { seedPreview } from './seed.mjs';

export async function preview({test=false}={}) {
  const webPort=Number(process.env.TF_PREVIEW_PORT??3200);
  if (!Number.isInteger(webPort)||webPort<1024||webPort>65535||webPort===3100) throw new Error('Port web Preview invalide.');
  const forwarded=codespacesOrigin(process.env,webPort);
  const origin=process.env.TF_PREVIEW_ORIGIN||forwarded||'http://127.0.0.1:'+webPort;
  const url=new URL(origin);
  if (url.origin!==origin || !(url.protocol==='https:' || origin==='http://127.0.0.1:'+webPort)) throw new Error('Origine Preview invalide.');
  let embedded,isolated,api,web;
  async function close() {
    if (web?.pid&&web.exitCode===null) {web.kill('SIGTERM');await once(web,'exit');}
    await api?.close();
    await isolated?.close();
    await embedded?.stop();
  }
  try {
    const ownerUrl=process.env.TF_MIGRATION_DATABASE_URL||(embedded=await localPostgres()).url;
    isolated=await fixture(ownerUrl);
    api=await createApp({origin,databaseUrl:isolated.runtimeUrl,dataKey:isolated.dataKey,secure:url.protocol==='https:',host:'127.0.0.1',port:3100});
    const scenario=await seedPreview(isolated,api.getHttpAdapter().getInstance(),origin);
    await api.listen(3100,'127.0.0.1');
    const webDirectory=fileURLToPath(new URL('../web/',import.meta.url));
    const host=process.env.TF_PREVIEW_BIND==='0.0.0.0'&&!forwarded?'0.0.0.0':'127.0.0.1';
    web=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p',String(webPort),'-H',host],
      {cwd:webDirectory,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},stdio:'inherit'});
    for(let attempt=0;attempt<100;attempt++){
      try {
        const res=await fetch('http://127.0.0.1:'+webPort+'/api/v2/health/ready');
        if (res.ok) break;
      } catch {}
      if (attempt===99 || web.exitCode!==null) throw new Error('Next.js Preview ne répond pas.');
      await new Promise(resolve=>setTimeout(resolve,140));
    }
    const profiles=Object.fromEntries(['staff','agency','merchant'].map(role=>[role,isolated.accounts[role]]));
    if (!test) {
      console.log('TransitFlow V2 — Preview de données fictives uniquement');
      console.log('URL : '+origin);
      for(const profile of Object.values(profiles)) console.log(profile.login+'  '+profile.password);
      console.log('Code de retour à tester : '+scenario.returnCode);
    }
    return {origin,profiles,scenario,close};
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const running=await preview();
  let stopping=false;
  async function stop(){
    if (stopping) return;
    stopping=true;
    await running.close();
    process.exit(0);
  }
  process.on('SIGTERM',stop);
  process.on('SIGINT',stop);
}
