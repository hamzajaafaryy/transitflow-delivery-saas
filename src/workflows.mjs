import {returnNetworkRoute} from './return-network.mjs';
import {id,now} from './db.mjs';
import {PERMISSIONS,ROLE_LABELS,has,requirePermission,agencyScoped,shipmentScope} from './access.mjs';
import {clean,fail,shipment,isoDate,parcelEvent,integer} from './workflow-shared.mjs';
import {pickupRoute} from './pickups.mjs';
import {returnRoute} from './returns.mjs';
import {claimRoute} from './claims.mjs';
import {deliveryRoute} from './delivery.mjs';
import {cashRoute} from './cash.mjs';
import {warehouseRoute} from './warehouse.mjs';

export async function workflowRoute(ctx){
 const {path,method,user,companyId,stmt,all,run,tx,json,send,audit}=ctx;
 if(path==='/api/workflow/bootstrap'&&method==='GET'){
  const agencyArgs=agencyScoped(user)?[companyId,user.agency_id||'NO_AGENCY']:[companyId],directory=has(user,'directory')||has(user,'pickups.manage')||has(user,'routes.manage');
  const agencies=all('SELECT id,name,city,kind,fee_centimes FROM agencies WHERE company_id=?'+(agencyScoped(user)?' AND id=?':'')+' ORDER BY city',...agencyArgs);
  const users=directory?all('SELECT id,full_name,role,agency_id,phone FROM users WHERE company_id=? AND active=1'+(agencyScoped(user)?' AND agency_id=?':'')+' ORDER BY full_name',...agencyArgs):[];
  const merchants=user.role==='MERCHANT'?all('SELECT id,name FROM merchants WHERE id=? AND company_id=?',user.merchant_id,companyId):directory?all('SELECT id,name,phone FROM merchants m WHERE company_id=?'+(agencyScoped(user)?' AND EXISTS(SELECT 1 FROM shipments s WHERE s.merchant_id=m.id AND s.company_id=m.company_id AND s.agency_id=?)':'')+' ORDER BY name',...agencyArgs):[];
  return send(ctx.res,200,{roles:ROLE_LABELS,permissions:PERMISSIONS[user.role],agencies,users,merchants,settings:stmt('SELECT claim_sla_hours,max_delivery_attempts FROM operation_settings WHERE company_id=?',companyId)||{claim_sla_hours:24,max_delivery_attempts:3}});
 }
 if(path==='/api/workflow/eligible'&&method==='GET'){
  const kind=ctx.url.searchParams.get('kind'),mid=user.role==='MERCHANT'?user.merchant_id:ctx.url.searchParams.get('merchantId'),aid=ctx.url.searchParams.get('agencyId'),scope=shipmentScope(user,'s'),where=['s.company_id=?'+scope.clause],args=[companyId,...scope.args];
  if(kind==='pickup'){requirePermission(user,'pickups.create','pickups.manage');where.push("s.order_source='EXTERNAL' AND s.status IN ('CREATED','AWAITING_PICKUP') AND s.reused_return_id IS NULL AND NOT EXISTS(SELECT 1 FROM pickup_items i WHERE i.shipment_id=s.id AND i.company_id=s.company_id AND i.active=1)");}
  else if(kind==='route'){requirePermission(user,'routes.manage');where.push("s.status IN ('PICKED_UP','AT_AGENCY','POSTPONED','UNREACHABLE') AND NOT EXISTS(SELECT 1 FROM delivery_route_items i WHERE i.shipment_id=s.id AND i.company_id=s.company_id AND i.active=1)");}
  else throw fail(400,'Liste éligible inconnue');if(mid){where.push('s.merchant_id=?');args.push(mid);}if(aid){where.push('s.agency_id=?');args.push(aid);}return send(ctx.res,200,{shipments:all(`SELECT s.id,s.tracking,s.recipient,s.city,s.merchant_id,s.cod_centimes,s.order_source,s.status FROM shipments s WHERE ${where.join(' AND ')} ORDER BY s.created_at LIMIT 1000`,...args)});
 }
 if(path==='/api/workflow/settings'&&method==='POST'){
  requirePermission(user,'*');const data=await json(ctx.req),hours=integer(data.claimSlaHours,1,720),attempts=integer(data.maxDeliveryAttempts,1,20);tx(()=>{run('INSERT INTO operation_settings(company_id,claim_sla_hours,max_delivery_attempts) VALUES(?,?,?) ON CONFLICT(company_id) DO UPDATE SET claim_sla_hours=excluded.claim_sla_hours,max_delivery_attempts=excluded.max_delivery_attempts',companyId,hours,attempts);audit(companyId,user.id,'OPERATION_POLICY_UPDATED','company',companyId,{hours,attempts});});return send(ctx.res,200,{ok:true});
 }
 if(path==='/api/workflow/notifications'&&method==='GET')return send(ctx.res,200,{notifications:all('SELECT * FROM notifications WHERE company_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100',companyId,user.id),unread:stmt('SELECT COUNT(*) AS n FROM notifications WHERE company_id=? AND user_id=? AND read_at IS NULL',companyId,user.id).n});
 if(path==='/api/workflow/notifications/read'&&method==='POST'){const data=await json(ctx.req);run('UPDATE notifications SET read_at=? WHERE company_id=? AND user_id=?'+(data.id?' AND id=?':''),...data.id?[now(),companyId,user.id,data.id]:[now(),companyId,user.id]);return send(ctx.res,200,{ok:true});}
 if(path==='/api/workflow/audit'&&method==='GET'){requirePermission(user,'*');return send(ctx.res,200,{logs:all('SELECT a.*,u.full_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id AND u.company_id=a.company_id WHERE a.company_id=? ORDER BY a.created_at DESC LIMIT 300',companyId)});}
 if(path==='/api/workflow/overview'&&method==='GET'){
  const scope=shipmentScope(user,'s'),shipments=all(`SELECT s.status,COUNT(*) AS n FROM shipments s WHERE s.company_id=?${scope.clause} GROUP BY s.status`,companyId,...scope.args),merchant=user.role==='MERCHANT',driver=user.role==='PICKUP_DRIVER',agency=agencyScoped(user);
  const picks=has(user,'pickups.manage')||has(user,'warehouse')||merchant||driver?all('SELECT state,COUNT(*) AS n FROM pickups WHERE company_id=?'+(merchant?' AND merchant_id=?':driver?' AND driver_id=?':'')+' GROUP BY state',...merchant?[companyId,user.merchant_id]:driver?[companyId,user.id]:[companyId]):[];
  const returnWhere=merchant?' AND r.merchant_id=?':['PICKUP_DRIVER','DRIVER'].includes(user.role)?' AND r.driver_id=?':agency?' AND s.agency_id=?':'';
  const args=merchant?[companyId,user.merchant_id]:['PICKUP_DRIVER','DRIVER'].includes(user.role)?[companyId,user.id]:agency?[companyId,user.agency_id||'NO_AGENCY']:[companyId];
  const returns=all('SELECT r.state,COUNT(*) AS n FROM parcel_returns r JOIN shipments s ON s.id=r.shipment_id AND s.company_id=r.company_id WHERE r.company_id=?'+returnWhere+' GROUP BY r.state',...args);
  const ownClaims=!merchant&&!has(user,'claims.manage')&&!has(user,'claims.read'),claimWhere=merchant?' AND c.merchant_id=?':ownClaims?' AND c.created_by=?':agency?" AND s.agency_id=? AND c.category<>'PAYMENT'":'',claimArgs=merchant?[user.merchant_id]:ownClaims?[user.id]:agency?[user.agency_id||'NO_AGENCY']:[];
  const overdueClaims=stmt("SELECT COUNT(*) AS n FROM claims c LEFT JOIN shipments s ON s.id=c.shipment_id AND s.company_id=c.company_id WHERE c.company_id=? AND c.state NOT IN ('RESOLVED','CLOSED') AND c.due_at<?"+claimWhere,companyId,now(),...claimArgs).n;
  const cityDistribution=all(`SELECT s.city,COUNT(*) AS total,SUM(CASE WHEN s.status='DELIVERED' THEN 1 ELSE 0 END) AS delivered FROM shipments s WHERE s.company_id=?${scope.clause} GROUP BY s.city ORDER BY total DESC,s.city LIMIT 6`,companyId,...scope.args);
  const recentShipments=all(`SELECT s.id,s.tracking,s.recipient,s.city,s.cod_centimes,s.status,s.created_at,m.name AS merchant_name FROM shipments s LEFT JOIN merchants m ON m.id=s.merchant_id AND m.company_id=s.company_id WHERE s.company_id=?${scope.clause} ORDER BY s.created_at DESC,s.id DESC LIMIT 5`,companyId,...scope.args);
  const recentActivity=all(`SELECT e.status,e.created_at,s.tracking,s.city FROM shipment_events e JOIN shipments s ON s.id=e.shipment_id AND s.company_id=e.company_id WHERE s.company_id=?${scope.clause} ORDER BY e.created_at DESC,e.rowid DESC LIMIT 5`,companyId,...scope.args);
  const intakeAllowed=['intakes.create','intakes.manage','intakes.receive','intakes.self','intakes.read'].some(p=>has(user,p)),intakes=intakeAllowed?all('SELECT state,COUNT(*) AS n FROM stock_intakes WHERE company_id=?'+(merchant?' AND merchant_id=?':driver?' AND driver_id=?':'')+' GROUP BY state',companyId,...merchant?[user.merchant_id]:driver?[user.id]:[]):[];
  const warehouseSummary={stockIntakes:Object.fromEntries(intakes.map(i=>[i.state,i.n])),stockCountsPending:has(user,'inventory.approve')?stmt("SELECT COUNT(*) AS n FROM stock_counts WHERE company_id=? AND state='SUBMITTED'",companyId).n:0,quarantinedUnits:has(user,'inventory.read')||merchant?stmt('SELECT COALESCE(SUM(quantity_remaining),0) AS n FROM stock_quarantine WHERE company_id=?'+(merchant?' AND merchant_id=?':''),companyId,...merchant?[user.merchant_id]:[]).n:0};
  let cashHeldCentimes=null;if(has(user,'cash.manage')||has(user,'finance')||has(user,'cash.read'))cashHeldCentimes=stmt("SELECT COALESCE(SUM(amount_centimes-agency_fee_centimes),0) AS n FROM cod_receipts WHERE company_id=? AND state<>'RECONCILED'",companyId).n;else if(has(user,'cash.self'))cashHeldCentimes=stmt("SELECT COALESCE(SUM(amount_centimes-agency_fee_centimes),0) AS n FROM cod_receipts WHERE company_id=? AND state<>'RECONCILED'"+(agency?' AND holder_agency_id=?':' AND holder_user_id=?'),companyId,agency?user.agency_id||'NO_AGENCY':user.id).n;
  return send(ctx.res,200,{...warehouseSummary,cityDistribution,recentShipments,recentActivity,cashHeldCentimes,shipments:Object.fromEntries(shipments.map(x=>[x.status,x.n])),pickups:Object.fromEntries(picks.map(x=>[x.state,x.n])),returns:Object.fromEntries(returns.map(x=>[x.state,x.n])),overdueClaims,unreconciledCodCentimes:has(user,'cash.manage')||has(user,'finance')?stmt("SELECT COALESCE(SUM(amount_centimes),0) AS n FROM cod_receipts WHERE company_id=? AND state<>'RECONCILED'",companyId).n:null});
 }
 const incident=path.match(/^\/api\/workflow\/shipments\/([a-f0-9-]{36})\/(incident|recover)$/);
 if(incident&&method==='POST'){
  requirePermission(user,'routes.manage');const s=shipment(ctx,incident[1]),data=await json(ctx.req),note=clean(data.note,500);if(note.length<5)throw fail(400,'Motif détaillé requis');
  if(incident[2]==='recover'){if(s.status!=='LOST')throw fail(409,'Colis non déclaré perdu');if(clean(data.scan).toUpperCase()!==s.tracking.toUpperCase()&&clean(data.scan)!==s.id)throw fail(409,'Scannez le colis retrouvé');tx(()=>{parcelEvent(ctx,s,'AT_AGENCY','Colis retrouvé : '+note,'INCIDENT');audit(companyId,user.id,'PARCEL_RECOVERED','shipment',s.id,{note});});}
  else {if(!['LOST','DAMAGED'].includes(data.kind)||['DELIVERED','RETURNED','RETURNED_MERCHANT','CANCELLED','LOST'].includes(s.status))throw fail(409,'Incident incompatible avec ce colis');tx(()=>{parcelEvent(ctx,s,data.kind,note,'INCIDENT');run("UPDATE delivery_route_items SET state='CANCELLED',active=0 WHERE shipment_id=? AND company_id=? AND active=1",s.id,companyId);audit(companyId,user.id,'PARCEL_INCIDENT_CONFIRMED','shipment',s.id,{kind:data.kind,note});});}
  return send(ctx.res,200,{ok:true});
 }
 const contact=path.match(/^\/api\/workflow\/shipments\/([a-f0-9-]{36})\/contact$/);
 if(contact&&method==='POST'){
  requirePermission(user,'claims.manage','routes.manage');const s=shipment(ctx,contact[1]),data=await json(ctx.req),outcome=data.outcome,note=clean(data.note,500),next=data.nextAttemptAt?isoDate(data.nextAttemptAt):null;
  if(!['REACHED','NO_ANSWER','WRONG_NUMBER','CALLBACK'].includes(outcome)||note.length<5||next&&next<=now())throw fail(400,'Résultat, note et date future valides requis');if(['DELIVERED','RETURNED','RETURNED_MERCHANT','CANCELLED','LOST'].includes(s.status))throw fail(409,'Colis clôturé');if(stmt("SELECT 1 FROM parcel_returns WHERE company_id=? AND shipment_id=? AND state NOT IN ('REQUESTED','CANCELLED','REJECTED')",companyId,s.id))throw fail(409,'Retour déjà engagé');
  tx(()=>{run('INSERT INTO contact_attempts VALUES(?,?,?,?,?,?,?,?)',id(),companyId,s.id,user.id,outcome,note,next,now());if(next){run('UPDATE shipments SET next_attempt_at=? WHERE id=? AND company_id=?',next,s.id,companyId);if(['UNREACHABLE','REFUSED','POSTPONED','AT_AGENCY'].includes(s.status))parcelEvent(ctx,s,'POSTPONED','Report confirmé par support : '+note,'SUPPORT');}audit(companyId,user.id,'CONTACT_ATTEMPT','shipment',s.id,{outcome,next,note});});return send(ctx.res,201,{ok:true});
 }
 if(/^\/api\/workflow\/(stock-intakes|catalog|stock-counts|stock-movements|quarantine|picking)(\/|$)/.test(path))return warehouseRoute(ctx);
 if(path.startsWith('/api/workflow/pickup')||path.startsWith('/api/workflow/vehicles'))return pickupRoute(ctx);
 if(/^\/api\/workflow\/(agency-parcels|return-containers|merchant-returns)(\/|$)/.test(path))return returnNetworkRoute(ctx);
 if(path.startsWith('/api/workflow/returns'))return returnRoute(ctx);
 if(path.startsWith('/api/workflow/claims'))return claimRoute(ctx);
 if(path.startsWith('/api/workflow/arrivals')||path.startsWith('/api/workflow/routes')||/^\/api\/workflow\/shipments\/[^/]+\/attempts$/.test(path))return deliveryRoute(ctx);
 if(path.startsWith('/api/workflow/cash')||path==='/api/workflow/adjustments')return cashRoute(ctx);
 throw fail(404,'Route de workflow introuvable');
}
