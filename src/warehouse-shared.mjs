import {createHash} from 'node:crypto';
import {id,now} from './db.mjs';
import {requirePermission} from './access.mjs';
import {clean,fail} from './workflow-shared.mjs';
import {stockMovement} from './stock-ledger.mjs';

export function stockScope(ctx,alias='p'){
 if(ctx.user.role==='MERCHANT')return {sql:` AND ${alias}.merchant_id=?`,args:[ctx.user.merchant_id]};
 requirePermission(ctx.user,'inventory.read');return {sql:'',args:[]};
}
export function requestKey(value){const key=clean(value,80);if(!/^[a-zA-Z0-9_-]{12,80}$/.test(key))throw fail(400,'Identifiant de requête requis (12 à 80 caractères)');return key;}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const requestHash=data=>createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex');
export function newStockLot(ctx,{productId,quantity,location,kind='RECEIPT',entityType,entityId,note='',eventKey,quarantine=0}){
 const lotId=id();ctx.run('INSERT INTO stock_lots(id,company_id,product_id,received_at,quantity_on_hand,location) VALUES(?,?,?,?,?,?)',lotId,ctx.companyId,productId,now(),quantity,location);
 stockMovement(ctx,{productId,lotId,kind,physical:quantity,quarantine,entityType,entityId,note,eventKey});return lotId;
}
export function createProduct(ctx,data){
 const merchantId=ctx.user.role==='MERCHANT'?ctx.user.merchant_id:data.merchantId||null;
 if(ctx.user.role==='MERCHANT'&&data.merchantId&&data.merchantId!==merchantId)throw fail(403,'Autre marchand interdit');
 if(merchantId&&!ctx.stmt('SELECT 1 FROM merchants WHERE id=? AND company_id=?',merchantId,ctx.companyId))throw fail(400,'Marchand invalide');
 const sku=clean(data.sku,70).toUpperCase(),name=clean(data.name,160),barcode=clean(data.barcode,90),threshold=Number(data.lowStockThreshold??0);
 if(!/^[A-Z0-9_-]{2,70}$/.test(sku)||!name||!Number.isSafeInteger(threshold)||threshold<0||threshold>1000000||barcode&&(!/^[A-Za-z0-9_.-]{2,90}$/.test(barcode)))throw fail(400,'SKU, nom, code-barres ou seuil invalide');
 // One scanned value must identify only one product within a merchant's catalog.
 if(ctx.stmt('SELECT 1 FROM inventory_products WHERE company_id=? AND merchant_id IS ? AND (sku=? OR (barcode<>\'\' AND barcode=? COLLATE NOCASE) OR (?<>\'\' AND (sku=? COLLATE NOCASE OR barcode=? COLLATE NOCASE)))',ctx.companyId,merchantId,sku,sku,barcode,barcode,barcode))throw fail(409,'SKU ou code-barres déjà utilisé pour ce marchand');
 const productId=id();ctx.run('INSERT INTO inventory_products(id,company_id,sku,name,merchant_id,created_at,barcode,low_stock_threshold) VALUES(?,?,?,?,?,?,?,?)',productId,ctx.companyId,sku,name,merchantId,now(),barcode,threshold);ctx.audit(ctx.companyId,ctx.user.id,'PRODUCT_CREATED','product',productId,{sku,merchantId});return {id:productId,sku,barcode};
}
