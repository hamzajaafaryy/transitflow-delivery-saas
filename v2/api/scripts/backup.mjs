import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, link, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { database } from '../dist/db.js';

const signature=Buffer.from('TFV2B001','ascii');
const headerSize=signature.length+12;
const tagSize=16;
const dailyPattern=/^transitflow-v2-daily-\d{4}-\d{2}-\d{2}\.pgdump\.enc$/;
const monthlyPattern=/^transitflow-v2-monthly-\d{4}-\d{2}\.pgdump\.enc$/;

function childEnv(connection) {
  const url=new URL(connection);
  const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  const mode=url.searchParams.get('sslmode')??(local?'prefer':null);
  if (!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||url.pathname.length<2) {
    throw new Error('PostgreSQL backup connection URL is invalid.');
  }
  if (!local&&mode!=='verify-full') throw new Error('Remote backup connections require sslmode=verify-full.');
  const inherited=Object.fromEntries(['PATH','LANG','LC_ALL','PGSSLROOTCERT','PGSSLCERT','PGSSLKEY','PGSSLCRL','TF_PG_SERVICE_ID']
    .filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
  return {...inherited,PGHOST:url.hostname.replace(/^\[|\]$/g,''),PGPORT:url.port||'5432',
    PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE:mode,PGAPPNAME:'transitflow-v2-backup'};
}

function pgCommand(bin,args,env,stdio) {
  const location=process.env.TF_PG_BIN_DIR;
  if (location&&!isAbsolute(location)) throw new Error('TF_PG_BIN_DIR must be an absolute path.');
  return spawn(location?join(location,bin):bin,args,{env,stdio});
}

async function checkedExit(child,label) {
  const [code]=await once(child,'exit');
  if (code!==0) throw new Error(label+' failed. Check PostgreSQL version, role and connectivity.');
}

async function ensurePrivate(directory) {
  if (!isAbsolute(directory)) throw new Error('Provide an absolute path to a private backup directory.');
  await mkdir(directory,{recursive:true,mode:0o700});
  const info=await stat(directory);
  if (!info.isDirectory() || info.mode&0o077) throw new Error('Backup directory must be private (mode 0700).');
}

async function linkOnce(source,target) {
  try { await link(source,target); }
  catch (error) { if (error.code!=='EEXIST') throw error; }
}

export async function pruneBackups(directory) {
  for (const [pattern,count] of [[dailyPattern,30],[monthlyPattern,12]]) {
    const files=(await readdir(directory,{withFileTypes:true})).filter(file=>file.isFile()&&pattern.test(file.name))
      .map(file=>file.name).sort().reverse();
    for (const name of files.slice(count)) await rm(join(directory,name),{force:true});
  }
}

export async function createBackup({directory,connection,key,day=new Date().toISOString().slice(0,10)}) {
  await ensurePrivate(directory);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || key.length!==32) throw new Error('Backup date or encryption key is invalid.');
  const env=childEnv(connection);
  const filename='transitflow-v2-daily-'+day+'.pgdump.enc';
  const daily=join(directory,filename);
  const monthly=join(directory,'transitflow-v2-monthly-'+day.slice(0,7)+'.pgdump.enc');
  const temporary=join(directory,'.partial-'+randomUUID());
  const header=Buffer.concat([signature,randomBytes(12)]);
  const cipher=createCipheriv('aes-256-gcm',key,header.subarray(signature.length));
  cipher.setAAD(header);
  let dump;
  try {
    await writeFile(temporary,header,{flag:'wx',mode:0o600});
    dump=pgCommand('pg_dump',['--format=custom','--schema=public','--no-owner'],env,['ignore','pipe','ignore']);
    await Promise.all([
      pipeline(dump.stdout,cipher,createWriteStream(temporary,{flags:'a'})),
      checkedExit(dump,'pg_dump'),
    ]);
    await appendFile(temporary,cipher.getAuthTag());
    const file=await open(temporary,'r');
    try {await file.sync();} finally {await file.close();}
    await linkOnce(temporary,daily);
    await linkOnce(daily,monthly);
    await pruneBackups(directory);
    return filename;
  } finally {
    if (dump?.pid&&dump.exitCode===null) dump.kill('SIGTERM');
    await rm(temporary,{force:true});
  }
}

async function verifyAndDecrypt(archive,path,key) {
  const file=await open(archive,'r');
  let size,header,tag;
  try {
    const info=await file.stat();
    size=info.size;
    if (!info.isFile()||size<=headerSize+tagSize) throw new Error('Encrypted backup is invalid.');
    header=Buffer.alloc(headerSize);
    tag=Buffer.alloc(tagSize);
    await file.read(header,0,headerSize,0);
    await file.read(tag,0,tagSize,size-tagSize);
  } finally { await file.close(); }
  if (!header.subarray(0,signature.length).equals(signature)) throw new Error('Encrypted backup header is invalid.');
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(signature.length));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(archive,{start:headerSize,end:size-tagSize-1}),decipher,createWriteStream(path,{flags:'wx',mode:0o600}));
}

export async function restoreBackup({archive,connection,key}) {
  const name=basename(archive);
  if (!dailyPattern.test(name)&&!monthlyPattern.test(name)) throw new Error('Select a TransitFlow V2 backup file.');
  const env=childEnv(connection);
  if (!/^tf_restore_[a-z0-9_]{1,40}$/.test(env.PGDATABASE)||key.length!==32) {
    throw new Error('Restore only to an isolated, empty tf_restore_* PostgreSQL database.');
  }
  const directory=await mkdtemp(join(tmpdir(),'tf-v2-restore-'));
  const path=join(directory,'archive.dump');
  const pool=database(connection,1);
  let restore,client;
  try {
    await verifyAndDecrypt(archive,path,key);
    client=await pool.connect();
    await client.query("SELECT pg_advisory_lock(hashtextextended('transitflow-v2-backup-restore',0))");
    const existing=(await client.query("SELECT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')) AS occupied")).rows[0];
    if (existing.occupied) throw new Error('Restore target already contains application objects.');
    // A schema-scoped archive includes CREATE SCHEMA public. The guarded empty target
    // starts with PostgreSQL's default public schema, so let pg_restore recreate it.
    restore=pgCommand('pg_restore',['--dbname='+env.PGDATABASE,'--clean','--if-exists','--single-transaction','--exit-on-error','--no-owner'],env,['pipe','ignore','ignore']);
    await Promise.all([pipeline(createReadStream(path),restore.stdin),checkedExit(restore,'pg_restore')]);
    const result=(await client.query(`SELECT (SELECT COUNT(*)::int FROM v2_schema_migrations) AS migrations,
      (SELECT COUNT(*)::int FROM v2_orders) AS orders`)).rows[0];
    if (!result.migrations) throw new Error('Restored database lacks the migration ledger.');
    return result;
  } finally {
    if (restore?.pid&&restore.exitCode===null) restore.kill('SIGTERM');
    client?.release(true);
    await pool.end();
    await rm(directory,{recursive:true,force:true});
  }
}

if (process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const keyHex=process.env.TF_BACKUP_KEY??'';
  try {
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('TF_BACKUP_KEY requires 32 independent random bytes in hexadecimal.');
    const key=Buffer.from(keyHex,'hex');
    const command=process.argv[2];
    if (command==='create') {
      const filename=await createBackup({directory:process.env.TF_BACKUP_DIR??'',connection:process.env.TF_BACKUP_DATABASE_URL,key});
      console.log('Encrypted backup saved',filename);
    } else if (command==='restore') {
      const result=await restoreBackup({archive:process.argv[3]??'',connection:process.env.TF_RESTORE_DATABASE_URL,key});
      console.log('Restoration verified',result);
    } else throw new Error('Use create or restore <archive>.');
  } catch(error) {
    console.error(error instanceof Error?error.message:'Backup command failed.');
    process.exitCode=1;
  }
}
