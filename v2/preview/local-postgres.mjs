import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { database } from '../api/dist/db.js';

export async function localPostgres() {
  if (process.platform!=='linux'||!['x64','arm64'].includes(process.arch)||process.getuid?.()===0) {
    throw new Error('La Preview embarquée exige Linux x64/arm64 et un utilisateur standard. Utilisez TF_MIGRATION_DATABASE_URL pour votre propre PostgreSQL local.');
  }
  const directory=await mkdtemp(join(tmpdir(),'transitflow-v2-preview-'));
  const platform=process.arch==='x64'?'linux-x64':'linux-arm64';
  const bin=fileURLToPath(new URL('../api/node_modules/@embedded-postgres/'+platform+'/native/bin/',import.meta.url));
  const port=Number(process.env.TF_PREVIEW_PG_PORT??55433);
  if (!Number.isInteger(port)||port<1024||port>65535) throw new Error('Port PostgreSQL Preview invalide.');
  const password=randomBytes(24).toString('hex');
  const url=`postgresql://tf_preview_owner:${password}@127.0.0.1:${port}/postgres`;
  const pwfile=join(directory,'pw'),data=join(directory,'pg');
  let postgres;
  async function stop() {
    if (postgres?.pid&&postgres.exitCode===null) {
      postgres.kill('SIGTERM');
      await once(postgres,'exit');
    }
    await rm(directory,{recursive:true,force:true});
  }
  try {
    await writeFile(pwfile,password,{mode:0o600});
    const initialize=spawn(join(bin,'initdb'),['--username=tf_preview_owner','--pwfile='+pwfile,'--auth-host=scram-sha-256',
      '--auth-local=peer','--no-locale','-E','UTF8','-D',data],{stdio:['ignore','ignore','inherit']});
    const [exit]=await once(initialize,'exit');
    if (exit!==0) throw new Error('Initialisation de PostgreSQL Preview échouée.');
    await rm(pwfile);
    postgres=spawn(join(bin,'postgres'),['-D',data,'-p',String(port),'-h','127.0.0.1','-c','unix_socket_directories=',
      '-c','log_min_error_statement=panic'],{stdio:['ignore','ignore','inherit']});
    postgres.on('error',()=>undefined);
    const pool=database(url,1);
    try {
      for (let retry=0;retry<50;retry++) {
        try {
          await pool.query('SELECT 1');
          return {url,stop};
        } catch {
          if (postgres.exitCode!==null||retry===49) throw new Error('PostgreSQL Preview ne répond pas sur le port local.');
          await new Promise(resolve=>setTimeout(resolve,120));
        }
      }
    } finally {
      await pool.end();
    }
  } catch(error) {
    await stop();
    throw error;
  }
}
