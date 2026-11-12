import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cityKey } from './domain.mjs';
import { workflowSchema } from './workflow-db.mjs';

// Upgrade the previous pilot in place; never merge independent companies.
function migrateNames(db) {
  const tables=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name);
  const old=tables();
  const profile=old.includes('companies')?'companies':old.includes('company')?'company':null;
  if(profile&&db.prepare(`SELECT COUNT(*) AS n FROM ${profile}`).get().n>1)throw Error('Migration arrêtée : cette base contient plusieurs sociétés. Utilisez une base dédiée à votre société. Aucune donnée fusionnée ou supprimée.');
  if(old.includes('companies'))db.exec('ALTER TABLE companies RENAME TO company');
  if(old.includes('partners'))db.exec('ALTER TABLE partners RENAME TO agencies');
  for(const table of tables()){
    const cols=db.prepare(`PRAGMA table_info("${table}")`).all().map(x=>x.name);
    for(const [before,after] of [['tenant_id','company_id'],['partner_id','agency_id'],['pending_partner_update','pending_agency_update']]){
      if(cols.includes(before))db.exec(`ALTER TABLE "${table}" RENAME COLUMN ${before} TO ${after}`);
    }
  }
  if(old.includes('shipments'))db.exec("UPDATE shipments SET status='ASSIGNED_AGENCY' WHERE status='ASSIGNED_PARTNER'");
  if(old.includes('shipment_events'))db.exec("UPDATE shipment_events SET status='ASSIGNED_AGENCY' WHERE status='ASSIGNED_PARTNER'; UPDATE shipment_events SET source='AGENCY:'||substr(source,9) WHERE source LIKE 'PARTNER:%'");
}

function addColumn(db,table,name,definition){
  if(db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===name))return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);return true;
}

export function openDb(file = process.env.DB_PATH || './data/delivery.sqlite') {
  const full = file === ':memory:' ? file : resolve(file);
  if (full !== ':memory:') mkdirSync(dirname(full), { recursive: true });
  const db = new DatabaseSync(full);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
  migrateNames(db);
  db.exec(`
CREATE TABLE IF NOT EXISTS company (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL DEFAULT 'company' UNIQUE, name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'INTERNAL', created_at TEXT NOT NULL,
  singleton INTEGER NOT NULL DEFAULT 1 CHECK(singleton=1)
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id),
  full_name TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN','OPERATIONS','DRIVER','MERCHANT','FINANCE')),
  merchant_id TEXT REFERENCES merchants(id), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  UNIQUE(company_id,email)
);
CREATE INDEX IF NOT EXISTS users_company_role ON users(company_id,role);
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id),
  name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL,
  UNIQUE(company_id,name)
);
CREATE TABLE IF NOT EXISTS agencies (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id),
  name TEXT NOT NULL, cities TEXT NOT NULL DEFAULT '[]',
  contact TEXT, fee_centimes INTEGER NOT NULL DEFAULT 0,
  api_key_hash TEXT, status_map TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, UNIQUE(company_id,name)
);
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id),
  tracking TEXT NOT NULL, merchant_id TEXT, agency_id TEXT,
  driver_id TEXT, recipient TEXT NOT NULL, phone TEXT NOT NULL,
  city TEXT NOT NULL, address TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  cod_centimes INTEGER NOT NULL DEFAULT 0 CHECK(cod_centimes >= 0),
  status TEXT NOT NULL DEFAULT 'CREATED', external_tracking TEXT,
  external_status TEXT, external_updated_at TEXT,
  exported_at TEXT, handed_over_at TEXT, delivered_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(company_id,tracking),
  FOREIGN KEY(merchant_id) REFERENCES merchants(id),
  FOREIGN KEY(agency_id) REFERENCES agencies(id),
  FOREIGN KEY(driver_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS shipments_company_status ON shipments(company_id,status);
CREATE INDEX IF NOT EXISTS shipments_company_agency ON shipments(company_id,agency_id);
CREATE TABLE IF NOT EXISTS shipment_events (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, shipment_id TEXT NOT NULL REFERENCES shipments(id),
  status TEXT NOT NULL, source TEXT NOT NULL, external_event_id TEXT,
  note TEXT, actor_id TEXT, created_at TEXT NOT NULL,
  UNIQUE(company_id, source, external_event_id)
);
CREATE INDEX IF NOT EXISTS events_ship ON shipment_events(company_id,shipment_id,created_at);
CREATE TABLE IF NOT EXISTS manifests (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, agency_id TEXT NOT NULL,
  reference TEXT NOT NULL, shipment_count INTEGER NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manifest_shipments (
  company_id TEXT NOT NULL, manifest_id TEXT NOT NULL REFERENCES manifests(id),
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  PRIMARY KEY(manifest_id,shipment_id)
);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, shipment_id TEXT NOT NULL,
  type TEXT NOT NULL, amount_centimes INTEGER NOT NULL, note TEXT,
  actor_id TEXT, created_at TEXT NOT NULL,
  UNIQUE(company_id,shipment_id,type)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT, details TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_products (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id),
  sku TEXT NOT NULL, name TEXT NOT NULL, merchant_id TEXT,
  created_at TEXT NOT NULL, UNIQUE(company_id,sku)
);
CREATE TABLE IF NOT EXISTS stock_lots (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES inventory_products(id),
  received_at TEXT NOT NULL, quantity_on_hand INTEGER NOT NULL CHECK(quantity_on_hand>=0),
  quantity_reserved INTEGER NOT NULL DEFAULT 0 CHECK(quantity_reserved>=0),
  location TEXT NOT NULL DEFAULT 'ENTREPOT',
  CHECK(quantity_reserved <= quantity_on_hand)
);
CREATE TABLE IF NOT EXISTS stock_allocations (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, shipment_id TEXT NOT NULL REFERENCES shipments(id),
  product_id TEXT NOT NULL REFERENCES inventory_products(id), lot_id TEXT NOT NULL REFERENCES stock_lots(id),
  quantity INTEGER NOT NULL CHECK(quantity>0),
  state TEXT NOT NULL CHECK(state IN ('RESERVED','DISPATCHED','RELEASED')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shipment_notes (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id),
  shipment_id TEXT NOT NULL REFERENCES shipments(id), actor_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shipment_notes_lookup ON shipment_notes(company_id,shipment_id,created_at);
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  inserted INTEGER NOT NULL, skipped INTEGER NOT NULL, filename TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
  // Upgrade pilot databases without dropping orders or agency events.
  if (!db.prepare('PRAGMA table_info(shipments)').all().some(x=>x.name==='pending_agency_update')) {
    db.exec('ALTER TABLE shipments ADD COLUMN pending_agency_update INTEGER NOT NULL DEFAULT 0');
  }
  // Merchant tariffs and reconciled statements are immutable snapshots once created.
  db.exec(`
CREATE TABLE IF NOT EXISTS merchant_rate_cards (
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id),
 merchant_id TEXT NOT NULL REFERENCES merchants(id), city_key TEXT NOT NULL,
 fee_centimes INTEGER NOT NULL CHECK(fee_centimes>=0), updated_at TEXT NOT NULL,
 UNIQUE(company_id,merchant_id,city_key)
);
CREATE TABLE IF NOT EXISTS merchant_statements (
 id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES company(id),
 merchant_id TEXT NOT NULL REFERENCES merchants(id),reference TEXT NOT NULL,
 service_date TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('DRAFT','APPROVED','PAID')),
 shipment_count INTEGER NOT NULL,gross_centimes INTEGER NOT NULL,fee_centimes INTEGER NOT NULL,
 net_centimes INTEGER NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),
 confirmed_at TEXT,paid_at TEXT,payment_reference TEXT,
 UNIQUE(company_id,merchant_id,service_date), UNIQUE(company_id,reference)
);
CREATE TABLE IF NOT EXISTS merchant_statement_lines (
 id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES company(id),
 statement_id TEXT NOT NULL REFERENCES merchant_statements(id),
 shipment_id TEXT NOT NULL REFERENCES shipments(id),tracking TEXT NOT NULL,
 city TEXT NOT NULL,delivered_at TEXT NOT NULL,cod_centimes INTEGER NOT NULL,
 fee_centimes INTEGER NOT NULL,net_centimes INTEGER NOT NULL,
 UNIQUE(company_id,shipment_id)
);
CREATE INDEX IF NOT EXISTS merchant_statements_lookup ON merchant_statements(company_id,merchant_id,service_date);
  `);
  addColumn(db,'company','singleton','INTEGER NOT NULL DEFAULT 1 CHECK(singleton=1)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS single_company_profile ON company(singleton)');
  for(const [name,type] of [['city',"TEXT NOT NULL DEFAULT ''"],['city_key',"TEXT NOT NULL DEFAULT ''"],['kind',"TEXT NOT NULL DEFAULT 'PARTNER'"],['operator_name',"TEXT NOT NULL DEFAULT ''"]])addColumn(db,'agencies',name,type);
  // A former carrier covering multiple cities becomes one agency/hub per city.
  for(const agency of db.prepare("SELECT * FROM agencies WHERE city_key='' ORDER BY created_at,id").all()){
    const cities=[...new Map(JSON.parse(agency.cities||'[]').map(c=>[cityKey(c),String(c).trim()])).values()];
    if(!cities.length)throw Error('Agence historique sans ville : '+agency.name);
    db.prepare('UPDATE agencies SET city=?,city_key=?,operator_name=? WHERE id=?').run(cities[0],cityKey(cities[0]),agency.name,agency.id);
    for(const city of cities.slice(1)){
      const agencyId=randomUUID();
      db.prepare(`INSERT INTO agencies(id,company_id,name,cities,contact,fee_centimes,api_key_hash,status_map,created_at,city,city_key,kind,operator_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(agencyId,agency.company_id,agency.name+' · '+city,JSON.stringify([city]),agency.contact,agency.fee_centimes,agency.api_key_hash,agency.status_map,agency.created_at,city,cityKey(city),'PARTNER',agency.name);
      for(const shipment of db.prepare('SELECT id,city FROM shipments WHERE agency_id=? AND company_id=?').all(agency.id,agency.company_id)){
        if(cityKey(shipment.city)!==cityKey(city))continue;
        db.prepare('UPDATE shipments SET agency_id=? WHERE id=?').run(agencyId,shipment.id);
        db.prepare('UPDATE shipment_events SET source=? WHERE shipment_id=? AND company_id=? AND source=?').run('AGENCY:'+agencyId,shipment.id,agency.company_id,'AGENCY:'+agency.id);
      }
    }
  }
  // A city may be served by the internal hub and several external delivery partners.
  // Keep city lookup indexed, but do not enforce one agency per city.
  db.exec('DROP INDEX IF EXISTS agency_city_unique');
  db.exec('CREATE INDEX IF NOT EXISTS agencies_company_city_lookup ON agencies(company_id,city_key,kind,created_at)');
  const newSource=addColumn(db,'shipments','order_source',"TEXT NOT NULL DEFAULT 'EXTERNAL' CHECK(order_source IN ('EXTERNAL','STOCK'))");
  addColumn(db,'shipments','ramassed_at','TEXT');
  addColumn(db,'shipments','agency_fee_centimes','INTEGER NOT NULL DEFAULT 0 CHECK(agency_fee_centimes>=0)');
  if(newSource)db.exec(`UPDATE shipments SET order_source='STOCK' WHERE EXISTS(SELECT 1 FROM stock_allocations a WHERE a.shipment_id=shipments.id);
    UPDATE shipments SET ramassed_at=COALESCE(handed_over_at,updated_at) WHERE status IN ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','POSTPONED','DELIVERED','REFUSED','RETURNING','RETURNED');
    UPDATE shipments SET agency_fee_centimes=COALESCE((SELECT fee_centimes FROM agencies a WHERE a.id=shipments.agency_id),0)`);
  db.exec(`
CREATE TABLE IF NOT EXISTS dispatches (
 id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES company(id),agency_id TEXT NOT NULL REFERENCES agencies(id),
 reference TEXT NOT NULL UNIQUE,city TEXT NOT NULL,city_key TEXT NOT NULL,fee_centimes INTEGER NOT NULL CHECK(fee_centimes>=0),
 state TEXT NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CLOSED','SHIPPED','CANCELLED')),
 created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,closed_at TEXT,shipped_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_container_per_agency ON dispatches(company_id,agency_id) WHERE state='OPEN';
CREATE TABLE IF NOT EXISTS dispatch_items (
 company_id TEXT NOT NULL REFERENCES company(id),dispatch_id TEXT NOT NULL REFERENCES dispatches(id),
 shipment_id TEXT NOT NULL REFERENCES shipments(id),scanned_at TEXT,scanned_by TEXT REFERENCES users(id),
 PRIMARY KEY(dispatch_id,shipment_id),UNIQUE(company_id,shipment_id)
);
CREATE INDEX IF NOT EXISTS dispatch_items_lookup ON dispatch_items(company_id,dispatch_id,scanned_at);
  `);
  workflowSchema(db);
  const broken=db.prepare('PRAGMA foreign_key_check').all();if(broken.length)throw Error('Migration refusée : références incohérentes dans la base');
  db.exec('COMMIT; PRAGMA foreign_keys=ON');
  } catch(error) { db.exec('ROLLBACK');db.close();throw error; }
  return db;
}
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
