export const ROLE_LABELS={ADMIN:'Direction / administrateur',OPERATIONS:'Responsable exploitation',DISPATCHER:'Dispatcher / planification',WAREHOUSE:'Magasinier / préparation',PICKUP_DRIVER:'Ramasseur',AGENCY_MANAGER:'Responsable agence',AGENCY_AGENT:'Agent agence',DRIVER:'Livreur',SUPPORT:'Service client',FINANCE:'Comptabilité / caisse',MERCHANT:'Client marchand'};
export const ROLES=Object.keys(ROLE_LABELS);
export const PERMISSIONS={
 ADMIN:['*'],
 OPERATIONS:['shipments','shipments.read','shipments.create','agencies','directory','imports','export','users.read','inventory.read','inventory.write','inventory.approve','intakes.manage','intakes.receive','warehouse','dispatch','pickups.manage','routes.manage','agency.receive','returns.manage','returns.receive','claims.manage','reports','cash.read'],
 DISPATCHER:['shipments.read','agencies','directory','users.read','pickups.manage','intakes.manage','routes.manage','dispatch','reports','claims.create'],
 WAREHOUSE:['shipments.read','agencies','directory','inventory.read','inventory.write','warehouse','dispatch','intakes.create','intakes.receive','returns.receive','reports','claims.create'],
 PICKUP_DRIVER:['intakes.self','pickups.self','vehicles.self','claims.create'],
 AGENCY_MANAGER:['shipments.read','agencies','directory','users.read','dispatch','agency.receive','routes.manage','returns.manage','claims.read','claims.reply','reports','cash.self'],
 AGENCY_AGENT:['shipments.read','agencies','agency.receive','dispatch.read','claims.read','claims.reply'],
 DRIVER:['driver','routes.self','cash.self','claims.create'],
 SUPPORT:['shipments.read','agencies','directory','pickups.read','intakes.read','claims.manage','returns.manage','reports'],
 FINANCE:['shipments.read','finance','directory','reports','cash.manage','claims.read','returns.read'],
 MERCHANT:['merchant','catalog.create','intakes.create','shipments.create','pickups.create','claims.create','returns.create']
};
export const has=(user,permission)=>PERMISSIONS[user.role]?.includes('*')||PERMISSIONS[user.role]?.includes(permission);
export const denied=(status,message)=>Object.assign(new Error(message),{status});
export function requirePermission(user,...permissions){if(!permissions.some(p=>has(user,p)))throw denied(403,'Action non autorisée pour ce compte');}
export const agencyScoped=user=>['AGENCY_MANAGER','AGENCY_AGENT'].includes(user.role);
export function requireAgency(user,agencyId){if(agencyScoped(user)&&(!user.agency_id||user.agency_id!==agencyId))throw denied(403,'Cette agence ne fait pas partie de votre périmètre');}
export function shipmentScope(user,alias='s'){
 const prefix=alias?alias+'.':'';
 if(user.role==='MERCHANT')return {clause:` AND ${prefix}merchant_id=?`,args:[user.merchant_id||'NO_MERCHANT']};
 if(user.role==='DRIVER')return {clause:` AND ${prefix}driver_id=?`,args:[user.id]};
 if(agencyScoped(user))return {clause:` AND ${prefix}agency_id=?`,args:[user.agency_id||'NO_AGENCY']};
 if(user.role==='PICKUP_DRIVER')return {clause:` AND EXISTS(SELECT 1 FROM pickup_items spi JOIN pickups sp ON sp.id=spi.pickup_id AND sp.company_id=spi.company_id WHERE spi.shipment_id=${prefix}id AND spi.company_id=${prefix}company_id AND sp.driver_id=?)`,args:[user.id]};
 return {clause:'',args:[]};
}
export function requireShipmentAccess(ctx,shipment){
 const {user,companyId}=ctx;if(!shipment||shipment.company_id!==companyId)throw denied(404,'Colis introuvable');
 if(user.role==='MERCHANT'&&shipment.merchant_id!==user.merchant_id)throw denied(403,'Colis d’un autre marchand');
 if(user.role==='DRIVER'&&shipment.driver_id!==user.id)throw denied(403,'Colis non affecté à votre compte');
 if(agencyScoped(user))requireAgency(user,shipment.agency_id);
 if(user.role==='PICKUP_DRIVER'&&!ctx.stmt('SELECT 1 FROM pickup_items i JOIN pickups p ON p.id=i.pickup_id AND p.company_id=i.company_id WHERE i.shipment_id=? AND i.company_id=? AND p.driver_id=?',shipment.id,companyId,user.id))throw denied(403,'Colis hors de vos ramassages');
 return shipment;
}
