import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBackup,pruneBackups,restoreBackup } from '../scripts/backup.mjs';
import { database } from '../dist/db.js';
import { fixture } from './fixture.mjs';

test('encrypted pg_dump round trip, role isolation, authentication and retention',async t=>{
  assert.ok(process.env.TF_MIGRATION_DATABASE_URL);
  const fixtureDb=await fixture(process.env.TF_MIGRATION_DATABASE_URL);
  const directory=await mkdtemp(join(tmpdir(),'tf-v2-backup-ci-'));
  const owner=database(process.env.TF_MIGRATION_DATABASE_URL);
  const name='tf_restore_'+randomBytes(7).toString('hex');
  t.after(async()=>{
    await owner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await owner.end();
    await fixtureDb.close();
    await rm(directory,{recursive:true,force:true});
  });
  const sourceUrl=new URL(process.env.TF_MIGRATION_DATABASE_URL);
  sourceUrl.pathname=new URL(fixtureDb.runtimeUrl).pathname;
  const key=randomBytes(32);
  const marker='BOXSH-RESTORE-QA';
  await fixtureDb.db.query(`INSERT INTO v2_orders(tracking_code,merchant_id,source,status,cod_centimes)
    VALUES($1,$2,'EXTERNAL','ATTENTE_RAMASSAGE',12345)`,[marker,fixtureDb.merchants[0].id]);
  const filename=await createBackup({directory,connection:sourceUrl.href,key,day:'2026-11-10'});
  const archive=join(directory,filename);
  const bytes=await readFile(archive);
  assert.equal(bytes.subarray(0,8).toString(),'TFV2B001');
  assert.ok(!bytes.includes(Buffer.from('PGDMP')));
  assert.ok(!bytes.includes(Buffer.from(marker)));
  await owner.query(`CREATE DATABASE ${name}`);
  const target=new URL(process.env.TF_MIGRATION_DATABASE_URL);
  target.pathname='/'+name;
  await assert.rejects(restoreBackup({archive,connection:target.href,key:randomBytes(32)}));
  const {migrations}=await fixtureDb.query('SELECT count(*)::int AS migrations FROM v2_schema_migrations');
  assert.deepEqual(await restoreBackup({archive,connection:target.href,key}),{migrations,orders:1});
  const restored=database(target.href);
  try {
    assert.equal((await restored.query('SELECT cod_centimes FROM v2_orders WHERE tracking_code=$1',[marker])).rows[0].cod_centimes,'12345');
    assert.deepEqual((await restored.query(`SELECT has_table_privilege('transitflow_v2_runtime','v2_orders','SELECT') AS can_read,
      has_column_privilege('transitflow_v2_runtime','v2_return_bon_lines','received_at','UPDATE') AS can_modify_evidence`)).rows[0],{can_read:true,can_modify_evidence:false});
    await assert.rejects(restoreBackup({archive,connection:target.href,key}),/already contains/);
  } finally { await restored.end(); }
  for (let i=1;i<=31;i++) {
    const day=String(i).padStart(2,'0');
    await writeFile(join(directory,'transitflow-v2-daily-2025-01-'+day+'.pgdump.enc'),'fixture');
  }
  for (const year of ['2024','2025']) for (let i=1;i<=12;i++) {
    const month=String(i).padStart(2,'0');
    await writeFile(join(directory,'transitflow-v2-monthly-'+year+'-'+month+'.pgdump.enc'),'fixture');
  }
  await writeFile(join(directory,'keep-this-file.txt'),'fixture');
  await pruneBackups(directory);
  const files=await readdir(directory);
  assert.equal(files.filter(name=>name.includes('-daily-')).length,30);
  assert.equal(files.filter(name=>name.includes('-monthly-')).length,12);
  assert.ok(files.includes('keep-this-file.txt'));
});
