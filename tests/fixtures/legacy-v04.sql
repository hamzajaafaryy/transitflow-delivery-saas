-- Schema fixture from the v0.4 pilot; used to verify data-preserving migration.

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'STARTER', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES companies(id),
  full_name TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN','OPERATIONS','DRIVER','MERCHANT','FINANCE')),
  merchant_id TEXT REFERENCES merchants(id), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  UNIQUE(tenant_id,email)
);
CREATE INDEX IF NOT EXISTS users_tenant_role ON users(tenant_id,role);
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL,
  UNIQUE(tenant_id,name)
);
CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, cities TEXT NOT NULL DEFAULT '[]',
  contact TEXT, fee_centimes INTEGER NOT NULL DEFAULT 0,
  api_key_hash TEXT, status_map TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, UNIQUE(tenant_id,name)
);
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES companies(id),
  tracking TEXT NOT NULL, merchant_id TEXT, partner_id TEXT,
  driver_id TEXT, recipient TEXT NOT NULL, phone TEXT NOT NULL,
  city TEXT NOT NULL, address TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  cod_centimes INTEGER NOT NULL DEFAULT 0 CHECK(cod_centimes >= 0),
  status TEXT NOT NULL DEFAULT 'CREATED', external_tracking TEXT,
  external_status TEXT, external_updated_at TEXT,
  exported_at TEXT, handed_over_at TEXT, delivered_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(tenant_id,tracking),
  FOREIGN KEY(merchant_id) REFERENCES merchants(id),
  FOREIGN KEY(partner_id) REFERENCES partners(id),
  FOREIGN KEY(driver_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS shipments_tenant_status ON shipments(tenant_id,status);
CREATE INDEX IF NOT EXISTS shipments_tenant_partner ON shipments(tenant_id,partner_id);
CREATE TABLE IF NOT EXISTS shipment_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, shipment_id TEXT NOT NULL REFERENCES shipments(id),
  status TEXT NOT NULL, source TEXT NOT NULL, external_event_id TEXT,
  note TEXT, actor_id TEXT, created_at TEXT NOT NULL,
  UNIQUE(tenant_id, source, external_event_id)
);
CREATE INDEX IF NOT EXISTS events_ship ON shipment_events(tenant_id,shipment_id,created_at);
CREATE TABLE IF NOT EXISTS manifests (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, partner_id TEXT NOT NULL,
  reference TEXT NOT NULL, shipment_count INTEGER NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manifest_shipments (
  tenant_id TEXT NOT NULL, manifest_id TEXT NOT NULL REFERENCES manifests(id),
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  PRIMARY KEY(manifest_id,shipment_id)
);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, shipment_id TEXT NOT NULL,
  type TEXT NOT NULL, amount_centimes INTEGER NOT NULL, note TEXT,
  actor_id TEXT, created_at TEXT NOT NULL,
  UNIQUE(tenant_id,shipment_id,type)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT, details TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_products (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES companies(id),
  sku TEXT NOT NULL, name TEXT NOT NULL, merchant_id TEXT,
  created_at TEXT NOT NULL, UNIQUE(tenant_id,sku)
);
CREATE TABLE IF NOT EXISTS stock_lots (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES inventory_products(id),
  received_at TEXT NOT NULL, quantity_on_hand INTEGER NOT NULL CHECK(quantity_on_hand>=0),
  quantity_reserved INTEGER NOT NULL DEFAULT 0 CHECK(quantity_reserved>=0),
  location TEXT NOT NULL DEFAULT 'ENTREPOT',
  CHECK(quantity_reserved <= quantity_on_hand)
);
CREATE TABLE IF NOT EXISTS stock_allocations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, shipment_id TEXT NOT NULL REFERENCES shipments(id),
  product_id TEXT NOT NULL REFERENCES inventory_products(id), lot_id TEXT NOT NULL REFERENCES stock_lots(id),
  quantity INTEGER NOT NULL CHECK(quantity>0),
  state TEXT NOT NULL CHECK(state IN ('RESERVED','DISPATCHED','RELEASED')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shipment_notes (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES companies(id),
  shipment_id TEXT NOT NULL REFERENCES shipments(id), actor_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shipment_notes_lookup ON shipment_notes(tenant_id,shipment_id,created_at);
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  inserted INTEGER NOT NULL, skipped INTEGER NOT NULL, filename TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE shipments ADD COLUMN pending_partner_update INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS merchant_rate_cards (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES companies(id),
 merchant_id TEXT NOT NULL REFERENCES merchants(id), city_key TEXT NOT NULL,
 fee_centimes INTEGER NOT NULL CHECK(fee_centimes>=0), updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,merchant_id,city_key)
);
CREATE TABLE IF NOT EXISTS merchant_statements (
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES companies(id),
 merchant_id TEXT NOT NULL REFERENCES merchants(id),reference TEXT NOT NULL,
 service_date TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('DRAFT','APPROVED','PAID')),
 shipment_count INTEGER NOT NULL,gross_centimes INTEGER NOT NULL,fee_centimes INTEGER NOT NULL,
 net_centimes INTEGER NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),
 confirmed_at TEXT,paid_at TEXT,payment_reference TEXT,
 UNIQUE(tenant_id,merchant_id,service_date), UNIQUE(tenant_id,reference)
);
CREATE TABLE IF NOT EXISTS merchant_statement_lines (
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES companies(id),
 statement_id TEXT NOT NULL REFERENCES merchant_statements(id),
 shipment_id TEXT NOT NULL REFERENCES shipments(id),tracking TEXT NOT NULL,
 city TEXT NOT NULL,delivered_at TEXT NOT NULL,cod_centimes INTEGER NOT NULL,
 fee_centimes INTEGER NOT NULL,net_centimes INTEGER NOT NULL,
 UNIQUE(tenant_id,shipment_id)
);
CREATE INDEX IF NOT EXISTS merchant_statements_lookup ON merchant_statements(tenant_id,merchant_id,service_date);
  