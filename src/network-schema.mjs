const add=(db,table,name,type)=>{if(!db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===name)){db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);return true;}return false;};
export function networkSchema(db){
 const migrate=add(db,'shipments','custody_type',"TEXT NOT NULL DEFAULT 'UNKNOWN'");
 add(db,'shipments','custody_agency_id','TEXT REFERENCES agencies(id)');
 add(db,'shipments','custody_updated_at','TEXT');
 add(db,'shipments','last_scanned_at','TEXT');
 add(db,'shipments','last_scanned_by','TEXT REFERENCES users(id)');
 add(db,'shipments','labels_printed_at','TEXT');
 add(db,'delivery_route_items','scanned_at','TEXT');
 add(db,'delivery_route_items','scanned_by','TEXT REFERENCES users(id)');
 add(db,'delivery_route_items','status_before_scan','TEXT');
 add(db,'delivery_route_items','custody_before_scan','TEXT');
 db.exec(`
 CREATE TABLE IF NOT EXISTS label_batches(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES company(id),merchant_id TEXT REFERENCES merchants(id),order_source TEXT NOT NULL CHECK(order_source IN ('STOCK','EXTERNAL')),created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS label_batch_items(batch_id TEXT NOT NULL REFERENCES label_batches(id),company_id TEXT NOT NULL REFERENCES company(id),shipment_id TEXT NOT NULL REFERENCES shipments(id),position INTEGER NOT NULL,PRIMARY KEY(batch_id,shipment_id));
 CREATE TABLE IF NOT EXISTS return_containers(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES company(id),agency_id TEXT NOT NULL REFERENCES agencies(id),reference TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('OPEN','CLOSED','SHIPPED','RECEIVED','CANCELLED')),proof_reference TEXT,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,closed_at TEXT,shipped_at TEXT,received_at TEXT);
 CREATE TABLE IF NOT EXISTS return_container_items(company_id TEXT NOT NULL REFERENCES company(id),container_id TEXT NOT NULL REFERENCES return_containers(id),shipment_id TEXT NOT NULL REFERENCES shipments(id),return_id TEXT REFERENCES parcel_returns(id),status_before_scan TEXT,scanned_at TEXT,scanned_by TEXT REFERENCES users(id),received_at TEXT,received_by TEXT REFERENCES users(id),condition TEXT,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(container_id,shipment_id));
 CREATE UNIQUE INDEX IF NOT EXISTS one_active_return_container ON return_container_items(company_id,shipment_id) WHERE active=1;
 CREATE TABLE IF NOT EXISTS merchant_return_bons(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES company(id),merchant_id TEXT NOT NULL REFERENCES merchants(id),reference TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('OPEN','COMPLETED','CANCELLED')),receiver_name TEXT,proof_reference TEXT,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,completed_at TEXT);
 CREATE TABLE IF NOT EXISTS merchant_return_bon_items(company_id TEXT NOT NULL REFERENCES company(id),bon_id TEXT NOT NULL REFERENCES merchant_return_bons(id),return_id TEXT NOT NULL REFERENCES parcel_returns(id),shipment_id TEXT NOT NULL REFERENCES shipments(id),scanned_at TEXT,scanned_by TEXT REFERENCES users(id),active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(bon_id,return_id));
 CREATE UNIQUE INDEX IF NOT EXISTS one_active_merchant_return_bon ON merchant_return_bon_items(company_id,return_id) WHERE active=1;
 CREATE INDEX IF NOT EXISTS shipments_custody ON shipments(company_id,custody_type,custody_agency_id,status);
 CREATE INDEX IF NOT EXISTS return_container_agency ON return_containers(company_id,agency_id,created_at);
 `);
 if(migrate){
  // Preserve uncertain legacy locations instead of inventing a physical receipt.
  db.exec(`UPDATE shipments SET custody_type=CASE
   WHEN status='DELIVERED' THEN 'RECIPIENT'
   WHEN status='RETURNED' THEN 'WAREHOUSE'
   WHEN status='RETURNING' THEN 'RETURN_TRANSIT'
   WHEN status='OUT_FOR_DELIVERY' AND driver_id IS NOT NULL THEN 'DRIVER'
   WHEN EXISTS(SELECT 1 FROM dispatch_items i WHERE i.shipment_id=shipments.id AND i.company_id=shipments.company_id AND i.received_at IS NOT NULL) OR status='AT_AGENCY' THEN 'AGENCY'
   WHEN EXISTS(SELECT 1 FROM dispatch_items i JOIN dispatches d ON d.id=i.dispatch_id AND d.company_id=i.company_id WHERE i.shipment_id=shipments.id AND i.company_id=shipments.company_id AND d.state='SHIPPED') THEN 'OUTBOUND'
   WHEN ramassed_at IS NOT NULL THEN 'WAREHOUSE'
   WHEN status='COLLECTED' THEN 'PICKUP_DRIVER'
   WHEN order_source='STOCK' THEN 'WAREHOUSE' ELSE 'MERCHANT' END,
   custody_updated_at=updated_at;
   UPDATE shipments SET custody_agency_id=agency_id WHERE custody_type IN ('AGENCY','DRIVER','OUTBOUND','RETURN_TRANSIT');
   UPDATE delivery_route_items SET scanned_at=(SELECT created_at FROM delivery_routes r WHERE r.id=route_id),scanned_by=(SELECT created_by FROM delivery_routes r WHERE r.id=route_id) WHERE route_id IN (SELECT id FROM delivery_routes WHERE state IN ('ACTIVE','CLOSED'));
  `);
 }
}
