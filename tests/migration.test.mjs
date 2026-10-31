import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDb} from '../src/db.mjs';
import {hashPassword} from '../src/auth.mjs';
const schema=readFileSync(new URL('./fixtures/legacy-v04.sql',import.meta.url),'utf8');

test('v0.4 upgrade preserves merchant stock/statements/events and splits a carrier into city agencies',()=>{
 const dir=mkdtempSync(join(tmpdir(),'transitflow-migration-')),file=join(dir,'pilot.sqlite');
 try{
  const old=new DatabaseSync(file);old.exec(schema);
  old.prepare('INSERT INTO companies VALUES(?,?,?,?,?)').run('co','atlas','Atlas','STARTER','2026-10-30T10:00:00Z');
  old.prepare('INSERT INTO merchants VALUES(?,?,?,?,?)').run('merchant','co','Boutique','0600000000','2026-10-30T10:00:00Z');
  old.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run('user','co','Admin','admin@atlas.ma',hashPassword('strong-password-123'),'ADMIN',null,1,'2026-10-30T10:00:00Z');
  old.prepare('INSERT INTO partners VALUES(?,?,?,?,?,?,?,?,?)').run('partner','co','Transport Nord','["Tanger","Tétouan"]','contact',2000,'legacy-key','{}','2026-10-30T10:00:00Z');
  old.prepare(`INSERT INTO shipments(id,tenant_id,tracking,merchant_id,partner_id,recipient,phone,city,address,cod_centimes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ship','co','TF-LEGACY','merchant','partner','Client','0611111111','Tétouan','Rue 1',20000,'PICKED_UP','2026-10-30T10:00:00Z','2026-10-30T11:00:00Z');
  old.prepare('INSERT INTO shipment_events(id,tenant_id,shipment_id,status,source,external_event_id,created_at) VALUES(?,?,?,?,?,?,?)').run('event','co','ship','ASSIGNED_PARTNER','PARTNER:partner','old-event','2026-10-30T10:00:00Z');
  old.prepare('INSERT INTO inventory_products VALUES(?,?,?,?,?,?)').run('product','co','SKU-01','Article','merchant','2026-10-30T10:00:00Z');
  old.prepare('INSERT INTO stock_lots VALUES(?,?,?,?,?,?,?)').run('lot','co','product','2026-10-30T10:00:00Z',20,2,'Casablanca A');
  old.prepare('INSERT INTO stock_allocations VALUES(?,?,?,?,?,?,?,?)').run('allocation','co','ship','product','lot',2,'RESERVED','2026-10-30T10:00:00Z');
  old.prepare('INSERT INTO merchant_rate_cards VALUES(?,?,?,?,?,?)').run('rate','co','merchant','*',3000,'2026-10-30T10:00:00Z');
  old.close();
  let db=openDb(file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM company').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agencies').get().n,2);
  const shipment=db.prepare('SELECT s.*,a.city AS agency_city FROM shipments s JOIN agencies a ON a.id=s.agency_id WHERE s.id=?').get('ship');
  assert.equal(shipment.agency_city,'Tétouan');assert.equal(shipment.order_source,'STOCK');assert.ok(shipment.ramassed_at);
  assert.equal(db.prepare('SELECT quantity_on_hand,quantity_reserved FROM stock_lots').get().quantity_on_hand,20);
  assert.equal(db.prepare('SELECT quantity_reserved FROM stock_lots').get().quantity_reserved,2);
  assert.equal(db.prepare('SELECT merchant_id FROM inventory_products').get().merchant_id,'merchant');
  assert.equal(db.prepare('SELECT fee_centimes FROM merchant_rate_cards').get().fee_centimes,3000);
  const event=db.prepare('SELECT status,source FROM shipment_events').get();assert.equal(event.status,'ASSIGNED_AGENCY');assert.equal(event.source,'AGENCY:'+shipment.agency_id);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  db.close();db=openDb(file);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agencies').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shipments').get().n,1);db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('multi-company legacy databases are rejected atomically without changing or deleting their data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'transitflow-no-merge-')),file=join(dir,'pilot.sqlite');
 try{
  const old=new DatabaseSync(file);old.exec(schema);
  for(const code of ['one','two'])old.prepare('INSERT INTO companies VALUES(?,?,?,?,?)').run(code,code,code,'STARTER','2026-10-30');old.close();
  assert.throws(()=>openDb(file),/plusieurs sociétés/);
  const verify=new DatabaseSync(file);assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM companies').get().n,2);assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='company'").get().n,0);verify.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
