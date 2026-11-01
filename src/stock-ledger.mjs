import {id,now} from './db.mjs';
export function stockMovement(ctx,{productId,lotId=null,kind,physical=0,reserved=0,quarantine=0,entityType=null,entityId=null,note='',eventKey=id()}){
 const lot=lotId?ctx.stmt('SELECT * FROM stock_lots WHERE id=? AND company_id=?',lotId,ctx.companyId):null;
 const product=ctx.stmt('SELECT merchant_id FROM inventory_products WHERE id=? AND company_id=?',productId,ctx.companyId);
 ctx.run(`INSERT INTO stock_movements(id,company_id,merchant_id,product_id,lot_id,kind,physical_delta,reserved_delta,quarantine_delta,on_hand_after,reserved_after,entity_type,entity_id,note,actor_id,event_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id(),ctx.companyId,product.merchant_id,productId,lotId,kind,physical,reserved,quarantine,lot?.quantity_on_hand??null,lot?.quantity_reserved??null,entityType,entityId,String(note).slice(0,500),ctx.user?.id||null,eventKey,now());
}
export function activeVehicleMission(ctx,driverId,vehicleId){
 return Boolean(ctx.stmt("SELECT 1 FROM pickups WHERE company_id=? AND state='IN_PROGRESS' AND (driver_id=? OR vehicle_id=?)",ctx.companyId,driverId,vehicleId)||ctx.stmt("SELECT 1 FROM delivery_routes WHERE company_id=? AND state='ACTIVE' AND (driver_id=? OR (vehicle_id IS NOT NULL AND vehicle_id=?))",ctx.companyId,driverId,vehicleId)||ctx.stmt("SELECT 1 FROM stock_intakes WHERE company_id=? AND state='COLLECTING' AND (driver_id=? OR vehicle_id=?)",ctx.companyId,driverId,vehicleId));
}
