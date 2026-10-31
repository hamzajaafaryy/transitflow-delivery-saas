import {randomBytes} from 'node:crypto';
import {id,now} from './db.mjs';
import {denied,requirePermission,requireShipmentAccess,agencyScoped,requireAgency} from './access.mjs';
export const clean=(x,n=200)=>String(x??'').trim().slice(0,n);
export const fail=denied;
export const reference=prefix=>`${prefix}-${Date.now()}-${randomBytes(3).toString('hex').toUpperCase()}`;
export function isoDate(value,label='Date'){const d=new Date(value);if(!value||!Number.isFinite(d.getTime()))throw fail(400,label+' invalide');return d.toISOString();}
export function integer(value,min=1,max=100000){const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw fail(400,'Nombre invalide');return n;}
export function shipment(ctx,shipmentId){return requireShipmentAccess(ctx,ctx.stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',shipmentId,ctx.companyId));}
export function merchantId(ctx,requested){
 if(ctx.user.role==='MERCHANT'){if(requested&&requested!==ctx.user.merchant_id)throw fail(403,'Autre marchand interdit');return ctx.user.merchant_id;}
 requirePermission(ctx.user,'directory','pickups.manage','returns.manage','claims.manage','cash.manage','finance');
 if(!ctx.stmt('SELECT 1 FROM merchants WHERE id=? AND company_id=?',requested,ctx.companyId))throw fail(404,'Marchand introuvable');return requested;
}
export function scanShipment(ctx,value){let scan=clean(value,500);if(/^https?:\/\//i.test(scan)){try{scan=new URL(scan).pathname.split('/').filter(Boolean).at(-1);}catch{throw fail(400,'Scan invalide');}}
 if(!/^[A-Za-z0-9_-]{4,64}$/.test(scan))throw fail(400,'Tracking ou ID requis');
 const rows=ctx.all('SELECT * FROM shipments WHERE company_id=? AND (id=? OR tracking=? COLLATE NOCASE) LIMIT 2',ctx.companyId,scan,scan);if(!rows.length)throw fail(404,'Colis introuvable');if(rows.length!==1)throw fail(409,'Scan ambigu entre ID et tracking');return requireShipmentAccess(ctx,rows[0]);
}
export function parcelEvent(ctx,s,status,note,source='OPERATIONS'){
 ctx.run('UPDATE shipments SET status=?,updated_at=?,delivered_at=CASE WHEN ?=\'DELIVERED\' THEN COALESCE(delivered_at,?) ELSE delivered_at END WHERE id=? AND company_id=?',status,now(),status,now(),s.id,ctx.companyId);
 ctx.run('INSERT INTO shipment_events(id,company_id,shipment_id,status,source,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)',id(),ctx.companyId,s.id,status,source,clean(note,400),ctx.user.id,now());
}
export function notify(ctx,{merchant,users,roles,agency},title,type,entityId){
 const clauses=['company_id=?','active=1'],args=[ctx.companyId];
 if(merchant){clauses.push('merchant_id=?');args.push(merchant);}else if(users?.length){clauses.push(`id IN (${users.map(()=>'?').join(',')})`);args.push(...users);}else if(roles?.length){clauses.push(`role IN (${roles.map(()=>'?').join(',')})`);args.push(...roles);}else return;
 if(agency){clauses.push('agency_id=?');args.push(agency);}
 for(const user of ctx.all(`SELECT id FROM users WHERE ${clauses.join(' AND ')}`, ...args)){if(user.id===ctx.user?.id)continue;ctx.run('INSERT INTO notifications(id,company_id,user_id,title,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?)',id(),ctx.companyId,user.id,clean(title),type,entityId,now());}
}
export function pickupAccess(ctx,p){if(!p)throw fail(404,'Ramassage introuvable');if(ctx.user.role==='MERCHANT'&&p.merchant_id!==ctx.user.merchant_id)throw fail(403,'Ramassage d’un autre marchand');if(ctx.user.role==='PICKUP_DRIVER'&&p.driver_id!==ctx.user.id)throw fail(403,'Ramassage non affecté');if(!['MERCHANT','PICKUP_DRIVER'].includes(ctx.user.role))requirePermission(ctx.user,'pickups.manage','pickups.read','warehouse');return p;}
export function pickupReceived(ctx,s){
 const item=ctx.stmt("SELECT * FROM pickup_items WHERE company_id=? AND shipment_id=? AND active=1 AND state='COLLECTED'",ctx.companyId,s.id);if(!item)return;
 ctx.run("UPDATE pickup_items SET state='RECEIVED',received_at=?,active=0 WHERE company_id=? AND pickup_id=? AND shipment_id=?",now(),ctx.companyId,item.pickup_id,s.id);
 const p=ctx.stmt('SELECT * FROM pickups WHERE id=? AND company_id=?',item.pickup_id,ctx.companyId);
 if(['COLLECTED','PARTIAL'].includes(p.state)&&!ctx.stmt("SELECT 1 FROM pickup_items WHERE pickup_id=? AND company_id=? AND state='COLLECTED'",p.id,ctx.companyId)){
  ctx.run("UPDATE pickups SET state='RECEIVED',updated_at=? WHERE id=? AND company_id=?",now(),p.id,ctx.companyId);notify(ctx,{merchant:p.merchant_id},'Ramassage réceptionné au warehouse','pickup',p.id);
 }
}
export function returnAccess(ctx,r){if(!r)throw fail(404,'Retour introuvable');if(['PICKUP_DRIVER','DRIVER'].includes(ctx.user.role)){if(r.driver_id!==ctx.user.id)throw fail(403,'Retour non affecté');return r;}const s=shipment(ctx,r.shipment_id);if(ctx.user.role==='PICKUP_DRIVER'&&r.driver_id!==ctx.user.id)throw fail(403,'Retour non affecté');if(agencyScoped(ctx.user))requireAgency(ctx.user,s.agency_id);return r;}
export function html(res,content){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(content);}
export const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function documentHtml(title,body){return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:14px Arial,sans-serif;color:#17263f;margin:30px}h1{border-bottom:3px solid #4868df;padding-bottom:16px}table{border-collapse:collapse;width:100%}td,th{padding:10px;border:1px solid #dbe2ee;text-align:left}p{line-height:1.6}@media print{body{margin:10mm}}</style><h1>${esc(title)}</h1>${body}</html>`;}
