import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDb, now, id } from './db.mjs';
import { hashPassword, verifyPassword, signToken, verifyToken, makeKey, hashKey } from './auth.mjs';
import { STATUSES, STATUS_LABELS, canTransition, canAgencyTransition, mapAgencyStatus, validTracking, centimes, cityKey } from './domain.mjs';
import { xlsx, orderColumns, parseCsv, rowsToOrders } from './excel.mjs';
import { ticketHtml, publicTrackingHtml } from './ticket.mjs';
import { merchantRoute } from './merchant-portal.mjs';
import { logisticsRoute,reserveItems } from './logistics.mjs';
import {workflowRoute} from './workflows.mjs';
import {PERMISSIONS,ROLE_LABELS,ROLES,has,requirePermission,requireShipmentAccess,shipmentScope,agencyScoped,requireAgency} from './access.mjs';
import {recordCodReceipt} from './delivery.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../public');
const roles=PERMISSIONS;
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const sanitize=(s,len=160)=>String(s||'').trim().slice(0,len);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const utf8=new TextDecoder('utf-8',{fatal:true});
const mregex=(path,re)=>path.match(re);

export function buildServer({db=openDb(':memory:'),sessionSecret=process.env.SESSION_SECRET||randomBytes(40).toString('hex'),secureCookies=process.env.COOKIE_SECURE==='true',sameOrigin=process.env.PUBLIC_BASE_URL||'http://localhost:3000'}={}){
 const loginAttempts=new Map();
 const stmt=(q,...args)=>db.prepare(q).get(...args);
 const all=(q,...args)=>db.prepare(q).all(...args);
 const run=(q,...args)=>db.prepare(q).run(...args);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 const audit=(companyId,actor,action,entity,entityId,details={})=>run('INSERT INTO audit_logs VALUES (?,?,?,?,?,?,?,?)',id(),companyId,actor,action,entity,entityId,JSON.stringify(details),now());
 function send(res,status,data,headers={}){const text=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(text);}
 async function body(req,max=1024*1024){const chunks=[];let total=0;for await(const chunk of req){total+=chunk.length;if(total>max)throw fail(413,'Fichier trop volumineux');chunks.push(chunk);}return Buffer.concat(chunks);}
 async function json(req){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw fail(415,'Content-Type JSON requis');try{const data=JSON.parse(utf8.decode(await body(req,req.url.includes('/claims/')?1500000:1048576)));if(!data||typeof data!=='object'||Array.isArray(data))throw fail(400,'Objet JSON requis');return data;}catch(e){if(e.status)throw e;throw fail(400,'JSON invalide');}}
 function requireSession(req){
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('dn_session='))?.slice(11);
  const data=verifyToken(cookie,sessionSecret);if(!data)throw fail(401,'Connexion requise');
  const user=stmt('SELECT id,company_id,full_name,email,role,merchant_id,active,agency_id,phone FROM users WHERE id=? AND company_id=?',data.uid,data.cid||data.tid);
  if(!data.sid||!stmt('SELECT 1 FROM auth_sessions WHERE id=? AND user_id=? AND company_id=? AND expires_at>?',data.sid,data.uid,data.cid,now()))throw fail(401,'Session expirée ou révoquée');
  if(!user||!user.active||!stmt('SELECT 1 FROM company WHERE id=? AND singleton=1',user.company_id))throw fail(401,'Session invalide');return user;
 }
 function permit(user,permission){if(!roles[user.role]?.includes('*')&&!roles[user.role]?.includes(permission))throw fail(403,'Accès interdit');}
 function origin(req){
  if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return;
  // Agency API credentials are separate from browser sessions.
  if(req.url.startsWith('/api/integrations/'))return;
  const actual=req.headers.origin;
  if(actual){const expected=new URL(sameOrigin).origin;if(actual!==expected)throw fail(403,'Origine non autorisée');}
  if(req.headers['x-requested-with']!=='delivery-ui')throw fail(403,'En-tête anti-CSRF requis');
 }
 function createShipment(user,data){
  if(!data||typeof data!=='object'||Array.isArray(data))throw fail(400,'Commande invalide');
  const tracking=sanitize(data.tracking||`TF${randomBytes(8).toString('hex').toUpperCase()}`,64).toUpperCase();
  if(!validTracking(tracking))throw fail(400,'Tracking invalide');
  const recipient=sanitize(data.recipient),phone=sanitize(data.phone,35),city=sanitize(data.city,90),address=sanitize(data.address,400),description=sanitize(data.description,250);
  if(!recipient||!phone||!city||!address)throw fail(400,'Champs commande manquants');
  const isMerchant=user.role==='MERCHANT';
  if(isMerchant&&(!user.merchant_id||data.agencyId||data.partnerId||data.driverId||(data.merchantId&&data.merchantId!==user.merchant_id)))throw fail(403,'Affectation non autorisée pour ce marchand');
  const merchantId=isMerchant?user.merchant_id:(data.merchantId||null),driverId=isMerchant?null:(data.driverId||null);
  const agency=data.agencyId?stmt('SELECT * FROM agencies WHERE id=? AND company_id=?',data.agencyId,user.company_id):stmt('SELECT * FROM agencies WHERE company_id=? AND city_key=?',user.company_id,cityKey(city));
  if(!agency||agency.city_key!==cityKey(city))throw fail(400,'Ville non configurée : ajoutez son agence / hub avant de créer le colis');
  if(merchantId&&!stmt('SELECT 1 FROM merchants WHERE id=? AND company_id=?',merchantId,user.company_id))throw fail(400,'Marchand invalide');
  if(driverId&&!stmt("SELECT 1 FROM users WHERE id=? AND company_id=? AND role='DRIVER' AND active=1",driverId,user.company_id))throw fail(400,'Livreur invalide');
  if(data.fragile!==undefined&&typeof data.fragile!=='boolean'||data.allowOpen!==undefined&&typeof data.allowOpen!=='boolean')throw fail(400,'Consignes colis invalides');
  const items=data.items??[],source=data.source||(Array.isArray(items)&&items.length?'STOCK':'EXTERNAL');
  if(!['EXTERNAL','STOCK'].includes(source)||!Array.isArray(items)||(source==='EXTERNAL'&&items.length))throw fail(400,'Source de commande ou produits invalides');
  const cod=centimes(data.cod??0),t=now(),shipId=id(),status='CREATED';
  try{run(`INSERT INTO shipments(id,company_id,tracking,merchant_id,agency_id,driver_id,recipient,phone,city,address,description,cod_centimes,status,created_at,updated_at,order_source,agency_fee_centimes)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,shipId,user.company_id,tracking,merchantId,agency.id,driverId,recipient,phone,agency.city,address,description,cod,status,t,t,source,agency.fee_centimes);}
  catch(e){if(String(e).includes('UNIQUE'))throw fail(409,`Tracking dupliqué: ${tracking}`);throw e;}
  run('UPDATE shipments SET sector=?,fragile=?,allow_open=? WHERE id=? AND company_id=?',sanitize(data.sector,100),data.fragile?1:0,data.allowOpen?1:0,shipId,user.company_id);
  if(source==='STOCK')reserveItems({stmt,all,run,companyId:user.company_id},{id:shipId,merchant_id:merchantId},items);
  run('INSERT INTO shipment_events(id,company_id,shipment_id,status,source,actor_id,created_at) VALUES(?,?,?,?,?,?,?)',id(),user.company_id,shipId,status,'INTERNAL',user.id,t);
  return {id:shipId,tracking,status,source,agencyId:agency.id};
 }
 function changeStatus(user,shipId,status,source,note='',externalEventId=null,externalStatus=null){
  const sh=stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',shipId,user.company_id);
  if(!sh)throw fail(404,'Colis introuvable');
  if(!STATUSES.includes(status)||!canTransition(sh.status,status))throw fail(409,`Transition invalide ${sh.status} → ${status}`);
  if(sh.status===status)return {tracking:sh.tracking,status:sh.status,unchanged:true};
  if(status!=='CANCELLED')throw fail(409,'Utilisez les actions de tentative, ramassage, envoi ou retour pour cette étape');
  if(['PICKED_UP','IN_TRANSIT'].includes(status))throw fail(409,'Utilisez le scan ramassage ou le départ du bon d’envoi');
  if(!sh.ramassed_at&&!['CANCELLED','ASSIGNED_AGENCY'].includes(status))throw fail(409,'Ramassage requis');
  if(stmt("SELECT 1 FROM dispatch_items i JOIN dispatches d ON d.id=i.dispatch_id WHERE i.shipment_id=? AND i.company_id=? AND d.state IN ('OPEN','CLOSED')",sh.id,user.company_id))throw fail(409,'Colis dans un container : terminez ou annulez cet envoi avant de changer son statut');
  const t=now();
  if(status==='CANCELLED'){
   run("UPDATE pickup_items SET state='MISSING',active=0,note='Commande annulée avant collecte' WHERE shipment_id=? AND company_id=? AND state='EXPECTED'",sh.id,user.company_id);
   const reserved=all("SELECT id,lot_id,quantity FROM stock_allocations WHERE company_id=? AND shipment_id=? AND state='RESERVED'",user.company_id,sh.id);
   for(const a of reserved){run('UPDATE stock_lots SET quantity_reserved=quantity_reserved-? WHERE id=? AND company_id=?',a.quantity,a.lot_id,user.company_id);run("UPDATE stock_allocations SET state='RELEASED' WHERE id=? AND company_id=?",a.id,user.company_id);}
  }
  run('UPDATE shipments SET status=?,updated_at=?,delivered_at=CASE WHEN ?=\'DELIVERED\' THEN ? ELSE delivered_at END,external_status=COALESCE(?,external_status),external_updated_at=CASE WHEN ? IS NULL THEN external_updated_at ELSE ? END WHERE id=? AND company_id=?',status,t,status,t,externalStatus,externalStatus,t,sh.id,user.company_id);
  run('INSERT INTO shipment_events(id,company_id,shipment_id,status,source,external_event_id,note,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',id(),user.company_id,sh.id,status,source,externalEventId,sanitize(note,400),user.id||null,t);
  audit(user.company_id,user.id||null,'STATUS_CHANGE','shipment',sh.id,{from:sh.status,to:status,source});
  return {tracking:sh.tracking,status,updatedAt:t};
 }
 async function handler(req,res){
  const url=new URL(req.url,'http://localhost');const path=url.pathname,method=req.method;
  res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try{
   if(method==='GET'&&path==='/api/health')return send(res,200,{ok:true,service:'transitflow-delivery',version:'0.6.0'});
   if(method==='GET'&&path==='/api/auth/setup'){const company=stmt('SELECT name FROM company WHERE singleton=1');return send(res,200,{setupRequired:!company,companyName:company?.name||null});}
   if(method==='GET'&&mregex(path,/^\/api\/tracking\/([a-zA-Z0-9_-]{4,64})$/)){
    const tracking=decodeURIComponent(path.split('/').at(-1));
    const record=stmt('SELECT id,tracking,status,city,created_at,updated_at FROM shipments WHERE tracking=? COLLATE NOCASE',tracking);
    // Only one unambiguous tracking record may be shown publicly.
    const count=stmt('SELECT COUNT(*) AS n FROM shipments WHERE tracking=? COLLATE NOCASE',tracking).n;
    if(count!==1||!record)throw fail(404,'Suivi indisponible');
    const events=all('SELECT status,created_at FROM shipment_events WHERE shipment_id=? ORDER BY created_at ASC',record.id);
    return send(res,200,{tracking:record.tracking,status:record.status,statusLabel:STATUS_LABELS[record.status],city:record.city,updatedAt:record.updated_at,events});
   }
   if(method==='GET'&&mregex(path,/^\/suivi\/([a-zA-Z0-9_-]{4,64})$/)){
    const tracking=path.split('/').at(-1);
    const record=stmt('SELECT id,tracking,status,city,updated_at FROM shipments WHERE tracking=? COLLATE NOCASE',tracking);
    const count=stmt('SELECT COUNT(*) AS n FROM shipments WHERE tracking=? COLLATE NOCASE',tracking).n;
    if(count!==1||!record)throw fail(404,'Suivi indisponible');
    const events=all('SELECT status,created_at FROM shipment_events WHERE shipment_id=? ORDER BY created_at ASC',record.id);
    const html=publicTrackingHtml({...record,tracking:record.tracking,statusLabel:STATUS_LABELS[record.status],updatedAt:record.updated_at,events:events.map(x=>({...x,label:STATUS_LABELS[x.status]}))});
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);
   }
   if(method==='POST'&&path==='/api/integrations/status'){
    const key=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!key||key.length>150)throw fail(401,'Clé API requise');
    const profile=stmt('SELECT id FROM company WHERE singleton=1');
    const candidates=profile?all('SELECT * FROM agencies WHERE api_key_hash=? AND company_id=?',hashKey(key),profile.id):[];
    let agency=candidates[0];
    if(!agency)throw fail(401,'Clé API invalide');
    const data=await json(req);const eventId=sanitize(data.eventId,100),tracking=sanitize(data.tracking,64),externalStatus=sanitize(data.status,100),externalTracking=sanitize(data.externalTracking,100);
    if(!eventId||!tracking||!externalStatus)throw fail(400,'eventId, tracking, status requis');
    const sh=stmt('SELECT s.* FROM shipments s JOIN agencies a ON a.id=s.agency_id AND a.company_id=s.company_id WHERE a.api_key_hash=? AND s.company_id=? AND (s.tracking=? OR s.external_tracking=?)',hashKey(key),profile.id,tracking,tracking);
    if(sh)agency=candidates.find(a=>a.id===sh.agency_id);
    if(sh&&(!sh.ramassed_at||(['CREATED','ASSIGNED_AGENCY','EXPORTED','PICKED_UP'].includes(sh.status)&&!stmt("SELECT 1 FROM dispatch_items i JOIN dispatches d ON d.id=i.dispatch_id AND d.company_id=i.company_id WHERE i.shipment_id=? AND i.company_id=? AND d.state='SHIPPED'",sh.id,sh.company_id))))throw fail(409,'Ramassage et départ du container requis avant les événements de l’agence');
    if(!sh)throw fail(404,'Colis non affecté à ce partenaire');
    if(stmt('SELECT 1 FROM shipment_events WHERE company_id=? AND source=? AND external_event_id=?',agency.company_id,`AGENCY:${agency.id}`,eventId))return send(res,200,{ok:true,duplicate:true,status:sh.status});
    let mapped=mapAgencyStatus(externalStatus,JSON.parse(agency.status_map));
    if(!mapped)throw fail(422,'Statut externe non configuré');
    // A carrier reporting a return is not a warehouse inspection or a stock receipt.
    if(mapped==='RETURNED')mapped='RETURNING';
    // Prevent upstream from asserting internal-only lifecycle transitions.
    if(['CREATED','EXPORTED','ASSIGNED_AGENCY','CANCELLED'].includes(mapped))throw fail(422,'Statut non autorisé pour API partenaire');
    const result=tx(()=>{
      const current=stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',sh.id,agency.company_id);
      if(mapped!=='RETURNING'&&stmt("SELECT 1 FROM parcel_returns WHERE company_id=? AND shipment_id=? AND active=1",agency.company_id,sh.id))throw fail(409,'Retour ouvert : mise à jour de livraison bloquée');
      if(!canAgencyTransition(current.status,mapped))throw fail(409,`Transition invalide ${current.status} → ${mapped}`);
      const t=now();
      run('UPDATE shipments SET status=?, external_status=?,external_tracking=COALESCE(NULLIF(?,\'\'),external_tracking),external_updated_at=?,updated_at=?,delivered_at=CASE WHEN ?=\'DELIVERED\' THEN COALESCE(delivered_at,?) ELSE delivered_at END,handed_over_at=CASE WHEN ?=\'PICKED_UP\' THEN COALESCE(handed_over_at,?) ELSE handed_over_at END WHERE id=? AND company_id=?',mapped,externalStatus,externalTracking,t,t,mapped,t,mapped,t,current.id,agency.company_id);
      run('INSERT INTO shipment_events(id,company_id,shipment_id,status,source,external_event_id,note,created_at) VALUES (?,?,?,?,?,?,?,?)',id(),agency.company_id,current.id,mapped,`AGENCY:${agency.id}`,eventId,`External: ${externalStatus}`,t);
      if(mapped==='DELIVERED')recordCodReceipt({stmt,run,companyId:agency.company_id},current,{holderAgencyId:agency.id});
      if(['DELIVERED','REFUSED','UNREACHABLE','POSTPONED','RETURNING'].includes(mapped))run("UPDATE delivery_route_items SET state='ATTEMPTED',active=0 WHERE company_id=? AND shipment_id=? AND active=1",agency.company_id,current.id);
      audit(agency.company_id,null,'AGENCY_SYNC','shipment',current.id,{agencyId:agency.id,eventId,from:current.status,to:mapped});
      return {ok:true,tracking:current.tracking,status:mapped};
    });return send(res,200,result);
   }
   if(method==='GET'&&!path.startsWith('/api/')){
    const assets={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/operations.js':'operations.js','/workflows.js':'workflows.js','/workflow-forms.js':'workflow-forms.js','/stock-lines.js':'stock-lines.js','/styles.css':'styles.css','/manifest.webmanifest':'manifest.webmanifest','/merchant.html':'merchant.html','/merchant.css':'merchant.css','/merchant.js':'merchant.js'};
    const filename=assets[path];if(!filename)throw fail(404,'Page introuvable');
    const data=readFileSync(resolve(root,filename));res.writeHead(200,{'Content-Type':mime[extname(filename)]||'application/manifest+json','Cache-Control':'no-store'});return res.end(data);
   }
   origin(req);
   if(method==='POST'&&path==='/api/auth/register')throw fail(410,'Inscription multi-sociétés supprimée. Utilisez la configuration initiale unique.');
   if(method==='POST'&&path==='/api/auth/setup'){
    if(stmt('SELECT 1 FROM company'))throw fail(409,'La société est déjà configurée. Connectez-vous.');
    const data=await json(req),name=sanitize(data.companyName),email=sanitize(data.email,200).toLowerCase(),fullName=sanitize(data.fullName,120);
    if(!name||!fullName||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw fail(400,'Informations invalides');
    const hash=hashPassword(data.password),companyId=id(),uid=id(),t=now();
    tx(()=>{if(stmt('SELECT 1 FROM company'))throw fail(409,'La société est déjà configurée');run('INSERT INTO company(id,slug,name,plan,created_at) VALUES(?,?,?,?,?)',companyId,'company',name,'INTERNAL',t);run('INSERT INTO users(id,company_id,full_name,email,password_hash,role,merchant_id,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)',uid,companyId,fullName,email,hash,'ADMIN',null,1,t);audit(companyId,uid,'COMPANY_CONFIGURED','company',companyId);});
    return send(res,201,{ok:true,companyName:name});
   }
   if(method==='POST'&&path==='/api/auth/login'){
    const data=await json(req),email=sanitize(data.email,200).toLowerCase();
    const company=stmt('SELECT id FROM company WHERE singleton=1');if(!company)throw fail(409,'Configurez la société pour commencer');
    const key=`${req.socket.remoteAddress}:${email}`,previous=loginAttempts.get(key)||{count:0,until:0};
    if(previous.until>Date.now())throw fail(429,'Trop de tentatives');
    const user=stmt('SELECT * FROM users WHERE company_id=? AND email=?',company.id,email);
    if(!user||!user.active||!verifyPassword(data.password,user.password_hash)){const count=previous.count+1;loginAttempts.set(key,{count,until:count>=8?Date.now()+900000:0});throw fail(401,'Identifiants incorrects');}
    loginAttempts.delete(key);
    const sessionId=id();run('INSERT INTO auth_sessions VALUES(?,?,?,?)',sessionId,user.company_id,user.id,new Date(Date.now()+8*3600000).toISOString());
    const cookie=`dn_session=${signToken({uid:user.id,cid:user.company_id,sid:sessionId},sessionSecret)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=28800${secureCookies?'; Secure':''}`;
    return send(res,200,{ok:true,role:user.role,name:user.full_name},{'Set-Cookie':cookie});
   }
   if(method==='POST'&&path==='/api/auth/logout'){
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('dn_session='))?.slice(11),session=verifyToken(token,sessionSecret);
    if(session?.sid)run('DELETE FROM auth_sessions WHERE id=? AND user_id=?',session.sid,session.uid);
    return send(res,200,{ok:true},{'Set-Cookie':`dn_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secureCookies?'; Secure':''}`});
   }
   const user=requireSession(req);
   const companyId=user.company_id;
   if(path.startsWith('/api/workflow/'))return await workflowRoute({path,method,url,req,res,user,companyId,stmt,all,run,tx,audit,send,json,createShipment});
   if(path==='/api/cities'||path.startsWith('/api/agencies')||path.startsWith('/api/dispatches')||path.startsWith('/api/operations/')||/^\/api\/shipments\/[a-f0-9-]{36}\/preparation$/.test(path))return await logisticsRoute({path,method,url,req,res,user,companyId,stmt,all,run,tx,audit,send,json});
   if(path.startsWith('/api/merchant/')||path.startsWith('/api/finance/merchant-')){
    return await merchantRoute({path,method,url,req,res,user,companyId,stmt,all,run,tx,audit,send,json,createShipment});
   }
   if(method==='GET'&&path==='/api/me'){
    const company=stmt('SELECT name FROM company WHERE id=?',companyId);
    return send(res,200,{user,company,permissions:roles[user.role],roleLabels:ROLE_LABELS,statusLabels:STATUS_LABELS});
   }
   if(method==='GET'&&path==='/api/stats'){
    const scoped=shipmentScope(user,'s');const clause=scoped.clause,args=[companyId,...scoped.args];
    const rows=all('SELECT s.status,COUNT(*) AS n FROM shipments s WHERE s.company_id=?'+clause+' GROUP BY status',...args),total=rows.reduce((s,x)=>s+x.n,0);
    const cod=stmt("SELECT COALESCE(SUM(s.cod_centimes),0) AS value FROM shipments s WHERE s.company_id=?"+clause+" AND status='DELIVERED'",...args).value;
    return send(res,200,{total,byStatus:Object.fromEntries(rows.map(x=>[x.status,x.n])),deliveredCodCentimes:cod,agencies:['MERCHANT','DRIVER'].includes(user.role)?0:stmt('SELECT COUNT(*) AS n FROM agencies WHERE company_id=?',companyId).n});
   }
   if(method==='GET'&&path==='/api/shipments'){
    const status=sanitize(url.searchParams.get('status'),30),search=sanitize(url.searchParams.get('q'),100);
    const scoped=shipmentScope(user,'s'),filter=[companyId,...scoped.args],where=['s.company_id=?'+scoped.clause];
    if(status){where.push('s.status=?');filter.push(status);}
    if(search){where.push('(s.tracking LIKE ? OR s.recipient LIKE ? OR s.city LIKE ?)');filter.push(`%${search}%`,`%${search}%`,`%${search}%`);}
    const limit=Math.min(300,Math.max(1,Number(url.searchParams.get('limit'))||100)),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    const total=stmt(`SELECT COUNT(*) AS n FROM shipments s WHERE ${where.join(' AND ')}`,...filter).n;
    const records=all(`SELECT s.*,p.name AS agency_name,u.full_name AS driver_name,m.name AS merchant_name,
     EXISTS(SELECT 1 FROM ledger l WHERE l.shipment_id=s.id AND l.company_id=s.company_id AND l.type='COD_COLLECTED') AS cod_collected,(SELECT c.state FROM cod_receipts c WHERE c.shipment_id=s.id AND c.company_id=s.company_id) AS cod_receipt_state
     FROM shipments s LEFT JOIN agencies p ON p.id=s.agency_id AND p.company_id=s.company_id
     LEFT JOIN users u ON u.id=s.driver_id AND u.company_id=s.company_id
     LEFT JOIN merchants m ON m.id=s.merchant_id AND m.company_id=s.company_id
     WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,...filter,Math.floor(limit),Math.floor(offset));
    return send(res,200,{shipments:records,total,limit,offset});
   }
   if(method==='POST'&&path==='/api/shipments'){
    permit(user,user.role==='MERCHANT'?'shipments.create':'shipments');const data=await json(req);return send(res,201,tx(()=>createShipment(user,data)));
   }
   // Details, ticket and notes are companyId-scoped and role-scoped (never public).
   const detailsMatch=mregex(path,/^\/api\/shipments\/([a-f0-9-]{36})(?:\/(ticket|notes))?$/);
   if(detailsMatch){
    const sh=stmt(`SELECT s.*,p.name AS agency_name,m.name AS merchant_name,u.full_name AS driver_name
      FROM shipments s LEFT JOIN agencies p ON p.id=s.agency_id AND p.company_id=s.company_id
      LEFT JOIN merchants m ON m.id=s.merchant_id AND m.company_id=s.company_id
      LEFT JOIN users u ON u.id=s.driver_id AND u.company_id=s.company_id
      WHERE s.id=? AND s.company_id=?`,detailsMatch[1],companyId);
    if(!sh)throw fail(404,'Colis introuvable');
    requireShipmentAccess({user,companyId,stmt},sh);
    if(method==='GET'&&!detailsMatch[2]){
      const events=all(`SELECT e.status,e.source,e.note,e.created_at,u.full_name AS actor_name
        FROM shipment_events e LEFT JOIN users u ON u.id=e.actor_id AND u.company_id=e.company_id
        WHERE e.shipment_id=? AND e.company_id=? ORDER BY e.created_at,e.rowid`,sh.id,companyId);
      const notes=['ADMIN','OPERATIONS'].includes(user.role)?all(`SELECT n.message,n.created_at,u.full_name AS author
         FROM shipment_notes n JOIN users u ON u.id=n.actor_id AND u.company_id=n.company_id
         WHERE n.shipment_id=? AND n.company_id=? ORDER BY n.created_at,n.rowid`,sh.id,companyId):[];
      const paid=stmt("SELECT COUNT(*) AS n FROM ledger WHERE shipment_id=? AND company_id=? AND type='COD_COLLECTED'",sh.id,companyId).n>0;
      return send(res,200,{shipment:sh,events,notes,codCollectionConfirmed:paid});
    }
    if(method==='GET'&&detailsMatch[2]==='ticket'){
      if(!['ADMIN','OPERATIONS','WAREHOUSE','DISPATCHER','AGENCY_MANAGER','AGENCY_AGENT','PICKUP_DRIVER','DRIVER','MERCHANT'].includes(user.role))throw fail(403,'Accès interdit');
      const company=stmt('SELECT name FROM company WHERE id=?',companyId);
      const publicBase=new URL(sameOrigin);
      const trackingUrl=`${publicBase.origin}/suivi/${encodeURIComponent(sh.tracking)}`;
      const html=ticketHtml({shipment:sh,company,merchantName:sh.merchant_name,agencyName:sh.agency_name,trackingUrl});
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);
    }
    if(method==='POST'&&detailsMatch[2]==='notes'){
      permit(user,'shipments');const data=await json(req),message=sanitize(data.message,400);
      if(message.length<2)throw fail(400,'Commentaire requis');
      const noteId=id();tx(()=>{run('INSERT INTO shipment_notes VALUES(?,?,?,?,?,?)',noteId,companyId,sh.id,user.id,message,now());audit(companyId,user.id,'SHIPMENT_NOTE','shipment',sh.id,{noteId});});
      return send(res,201,{id:noteId,ok:true});
    }
    if(method==='PATCH'&&!detailsMatch[2]){
      permit(user,'shipments');
      if(['DELIVERED','RETURNED','CANCELLED'].includes(sh.status))throw fail(409,'Colis clôturé');
      if(stmt("SELECT 1 FROM dispatch_items i JOIN dispatches d ON d.id=i.dispatch_id AND d.company_id=i.company_id WHERE i.shipment_id=? AND i.company_id=? AND d.state IN ('OPEN','CLOSED')",sh.id,companyId))throw fail(409,'Colis affecté à un envoi : annulez le container avant correction');
      const data=await json(req);
      if(data.city!==undefined&&sh.ramassed_at)throw fail(409,'Ville non modifiable après ramassage');
      const allowed=['recipient','phone','city','address','description','cod'];
      const fields=Object.keys(data).filter(x=>x!=='reason');
      if(!fields.length||fields.some(x=>!allowed.includes(x)))throw fail(400,'Champs invalides');
      const reason=sanitize(data.reason,200);
      if(reason.length<5)throw fail(400,'Motif de modification requis');
      if(fields.includes('cod')&&user.role!=='ADMIN')throw fail(403,'Modification COD réservée à Admin');
      if(fields.includes('cod')&&stmt("SELECT 1 FROM ledger WHERE company_id=? AND shipment_id=? AND type='COD_COLLECTED'",companyId,sh.id))throw fail(409,'COD déjà collecté');
      const max={recipient:160,phone:35,city:90,address:400,description:250};
      const next={};for(const f of fields){const value=f==='cod'?centimes(data.cod):sanitize(data[f],max[f]);if(f!=='description'&&f!=='cod'&&!value)throw fail(400,`Champ requis : ${f}`);next[f==='cod'?'cod_centimes':f]=value;}
      if(fields.includes('city')){const agency=stmt('SELECT id,city,fee_centimes FROM agencies WHERE company_id=? AND city_key=?',companyId,cityKey(next.city));if(!agency)throw fail(400,'Ville non configurée');next.city=agency.city;next.agency_id=agency.id;next.agency_fee_centimes=agency.fee_centimes;}
      const changed=Object.fromEntries(Object.entries(next).filter(([k,v])=>v!==sh[k]));
      if(!Object.keys(changed).length)return send(res,200,{ok:true,unchanged:true});
      const externalPending=Boolean(sh.agency_id&&['EXPORTED','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','POSTPONED','REFUSED'].includes(sh.status));
      tx(()=>{
        const keys=Object.keys(changed),values=Object.values(changed);
        run(`UPDATE shipments SET ${keys.map(k=>`${k}=?`).join(',')},pending_agency_update=CASE WHEN ? THEN 1 ELSE pending_agency_update END,updated_at=? WHERE id=? AND company_id=?`,...values,externalPending?1:0,now(),sh.id,companyId);
        audit(companyId,user.id,'SHIPMENT_EDIT','shipment',sh.id,{fields:keys,reason,before:Object.fromEntries(keys.map(k=>[k,sh[k]])),after:changed,externalPending});
      });
      return send(res,200,{ok:true,pendingAgencyUpdate:externalPending||Boolean(sh.pending_agency_update)});
    }
   }
   const statusMatch=mregex(path,/^\/api\/shipments\/([a-f0-9-]{36})\/status$/);
   if(method==='POST'&&statusMatch){
    const sh=stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',statusMatch[1],companyId);
    if(!sh)throw fail(404,'Colis introuvable');
    requireShipmentAccess({user,companyId,stmt},sh);
    if(user.role==='DRIVER'){if(sh.driver_id!==user.id)throw fail(403,'Colis non attribué');}
    else permit(user,'shipments');
    const data=await json(req);if(!STATUSES.includes(data.status))throw fail(400,'Statut inconnu');
    if(user.role==='DRIVER'&&!['OUT_FOR_DELIVERY','DELIVERED','REFUSED','POSTPONED'].includes(data.status))throw fail(403,'Statut interdit au livreur');
    return send(res,200,tx(()=>changeStatus(user,sh.id,data.status,'INTERNAL',data.note)));
   }
   if(method==='POST'&&path==='/api/shipments/assign'){
    permit(user,'shipments');const data=await json(req),sh=stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',data.shipmentId,companyId);
    if(!sh)throw fail(404,'Colis introuvable');if(!['CREATED','ASSIGNED_AGENCY','EXPORTED','PICKED_UP'].includes(sh.status))throw fail(409,'Affectation non autorisée à cette étape');
    if(stmt('SELECT 1 FROM dispatch_items WHERE shipment_id=? AND company_id=?',sh.id,companyId))throw fail(409,'Colis déjà affecté à un envoi');
    const agencyId=data.agencyId||sh.agency_id,agency=stmt('SELECT * FROM agencies WHERE company_id=? AND id=?',companyId,agencyId);
    if(!agency||agency.city_key!==cityKey(sh.city))throw fail(400,'Agence incompatible avec la ville');
    if(data.driverId&&!stmt("SELECT 1 FROM users WHERE company_id=? AND id=? AND role='DRIVER' AND active=1",companyId,data.driverId))throw fail(400,'Livreur invalide');
    tx(()=>{run('UPDATE shipments SET agency_id=?,driver_id=?,agency_fee_centimes=?,updated_at=? WHERE id=? AND company_id=?',agencyId,data.driverId||null,agency.fee_centimes,now(),sh.id,companyId);audit(companyId,user.id,'SHIPMENT_ASSIGN','shipment',sh.id,{agencyId,driverId:data.driverId||null});});return send(res,200,{ok:true});
   }
   if(method==='GET'&&path==='/api/users'){
    permit(user,'users.read');return send(res,200,{users:all('SELECT id,full_name,email,role,merchant_id,active,agency_id,phone FROM users WHERE company_id=?'+(agencyScoped(user)?' AND agency_id=?':'')+' ORDER BY full_name',...agencyScoped(user)?[companyId,user.agency_id||'NO_AGENCY']:[companyId])});
   }
   if(method==='POST'&&path==='/api/users'){
    permit(user,'*');const data=await json(req),name=sanitize(data.name,100),email=sanitize(data.email,180).toLowerCase(),role=data.role;
    if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!ROLES.includes(role))throw fail(400,'Utilisateur invalide');
    const merchantId=role==='MERCHANT'?sanitize(data.merchantId,40):null;
    if(role==='MERCHANT'&&!stmt('SELECT 1 FROM merchants WHERE company_id=? AND id=?',companyId,merchantId))throw fail(400,'Marchand invalide');
    const agencyId=data.agencyId||null;if(agencyId&&!stmt('SELECT 1 FROM agencies WHERE id=? AND company_id=?',agencyId,companyId))throw fail(400,'Agence invalide');if(['AGENCY_MANAGER','AGENCY_AGENT'].includes(role)&&!agencyId)throw fail(400,'Agence obligatoire pour ce rôle');
    const hash=hashPassword(data.password);const uid=id();
    try{run('INSERT INTO users(id,company_id,full_name,email,password_hash,role,merchant_id,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)',uid,companyId,name,email,hash,role,merchantId,1,now());}
    catch(e){if(String(e).includes('UNIQUE'))throw fail(409,'Email existant');throw e;}
    run('UPDATE users SET agency_id=?,phone=? WHERE id=? AND company_id=?',agencyId,sanitize(data.phone,35),uid,companyId);
    audit(companyId,user.id,'USER_CREATED','user',uid,{role});return send(res,201,{id:uid});
   }
   const userPatch=path.match(/^\/api\/users\/([a-f0-9-]{36})$/);
   if(method==='PATCH'&&userPatch){
    permit(user,'*');const target=stmt('SELECT * FROM users WHERE id=? AND company_id=?',userPatch[1],companyId);if(!target)throw fail(404,'Compte introuvable');const data=await json(req),allowed=['name','phone','active','role','merchantId','agencyId','password'];if(Object.keys(data).some(k=>!allowed.includes(k)))throw fail(400,'Champs compte invalides');
    const role=data.role??target.role,active=data.active===undefined?target.active:data.active===true?1:data.active===false?0:-1,mid=role==='MERCHANT'?(data.merchantId??target.merchant_id):null,aid=data.agencyId===undefined?target.agency_id:data.agencyId||null,name=data.name===undefined?target.full_name:sanitize(data.name,100);
    if(!ROLES.includes(role)||active<0||!name)throw fail(400,'Compte invalide');if(role==='MERCHANT'&&!stmt('SELECT 1 FROM merchants WHERE id=? AND company_id=?',mid,companyId))throw fail(400,'Marchand requis');if(aid&&!stmt('SELECT 1 FROM agencies WHERE id=? AND company_id=?',aid,companyId)||['AGENCY_MANAGER','AGENCY_AGENT'].includes(role)&&!aid)throw fail(400,'Agence requise ou invalide');
    if(target.role==='ADMIN'&&(!active||role!=='ADMIN')&&stmt("SELECT COUNT(*) AS n FROM users WHERE company_id=? AND role='ADMIN' AND active=1",companyId).n<=1)throw fail(409,'Le dernier administrateur actif doit être conservé');
    const passwordHash=data.password?hashPassword(data.password):target.password_hash;
    tx(()=>{run('UPDATE users SET full_name=?,phone=?,role=?,merchant_id=?,agency_id=?,active=?,password_hash=? WHERE id=? AND company_id=?',name,data.phone===undefined?target.phone:sanitize(data.phone,35),role,mid,aid,active,passwordHash,target.id,companyId);if(data.password||!active||role!==target.role||aid!==target.agency_id)run('DELETE FROM auth_sessions WHERE user_id=? AND company_id=?',target.id,companyId);audit(companyId,user.id,'USER_UPDATED','user',target.id,{role,active,agencyId:aid,passwordChanged:Boolean(data.password)});});return send(res,200,{ok:true});
   }
   if(method==='GET'&&path==='/api/merchants'){
    requirePermission(user,'directory');return send(res,200,{merchants:all('SELECT id,name,phone FROM merchants m WHERE company_id=?'+(agencyScoped(user)?' AND EXISTS(SELECT 1 FROM shipments s WHERE s.merchant_id=m.id AND s.company_id=m.company_id AND s.agency_id=?)':'')+' ORDER BY name',...agencyScoped(user)?[companyId,user.agency_id||'NO_AGENCY']:[companyId])});
   }
   if(method==='POST'&&path==='/api/merchants'){
    permit(user,'shipments');const data=await json(req),name=sanitize(data.name,120);if(!name)throw fail(400,'Nom requis');
    const mid=id();run('INSERT INTO merchants VALUES(?,?,?,?,?)',mid,companyId,name,sanitize(data.phone,35),now());return send(res,201,{id:mid});
   }
   if(method==='POST'&&path==='/api/import/orders'){
    permit(user,'imports');const contentType=req.headers['content-type']||'';if(!/(text\/csv|application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet|application\/octet-stream)/.test(contentType))throw fail(415,'Importer CSV ou XLSX');
    const raw=await body(req,4_000_000),rows=contentType.includes('text/csv')?parseCsv(utf8.decode(raw).replace(/^\uFEFF/,'')):xlsx('import',raw);
    if(rows.length>1001)throw fail(413,'Maximum 1000 commandes par import');
    const orders=rowsToOrders(rows);let inserted=0,skipped=0;const errors=[];
    tx(()=>{for(const order of orders){try{createShipment(user,order);inserted++;}catch(e){skipped++;errors.push({line:order.line,error:e.message});}}
      run('INSERT INTO imports VALUES (?,?,?,?,?,?,?)',id(),companyId,user.id,inserted,skipped,sanitize(req.headers['x-filename']||'import.xlsx',120),now());
      audit(companyId,user.id,'ORDERS_IMPORT','import',null,{inserted,skipped});});
    return send(res,200,{inserted,skipped,errors:errors.slice(0,100)});
   }
   if(method==='POST'&&path==='/api/ledger/collect'){
    permit(user,'finance');const data=await json(req),sh=stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',data.shipmentId,companyId);
    if(!sh)throw fail(404,'Colis introuvable');
    const receipt=stmt('SELECT state FROM cod_receipts WHERE shipment_id=? AND company_id=?',sh.id,companyId);if(receipt&&receipt.state!=='RECONCILED')throw fail(409,'Rapprochez la remise du livreur ou de l’agence avant confirmation COD');
    if(sh.status!=='DELIVERED')throw fail(409,'Livraison non confirmée');
    if(sh.cod_centimes===0)throw fail(409,'Aucun COD à collecter');
    try{tx(()=>{run('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)',id(),companyId,sh.id,'COD_COLLECTED',sh.cod_centimes,'Collecte confirmée manuellement',user.id,now());audit(companyId,user.id,'COD_COLLECTED','shipment',sh.id,{amount:sh.cod_centimes});});}
    catch(e){if(String(e).includes('UNIQUE'))throw fail(409,'COD déjà enregistré');throw e;}
    return send(res,201,{ok:true,amountCentimes:sh.cod_centimes});
   }
   if(method==='GET'&&path==='/api/ledger'){
    permit(user,'finance');return send(res,200,{entries:all('SELECT l.*,s.tracking FROM ledger l JOIN shipments s ON s.id=l.shipment_id AND s.company_id=l.company_id WHERE l.company_id=? ORDER BY l.created_at DESC LIMIT 150',companyId)});
   }
   if(method==='GET'&&path==='/api/inventory'){
    requirePermission(user,'inventory.read');
    const products=all(`SELECT p.id,p.sku,p.name,p.merchant_id,
      COALESCE(SUM(l.quantity_on_hand),0) AS on_hand,
      COALESCE(SUM(l.quantity_reserved),0) AS reserved
      FROM inventory_products p LEFT JOIN stock_lots l ON l.product_id=p.id AND l.company_id=p.company_id
      WHERE p.company_id=? GROUP BY p.id ORDER BY p.name`,companyId);
    return send(res,200,{products:products.map(p=>({...p,available:p.on_hand-p.reserved}))});
   }
   if(method==='POST'&&path==='/api/inventory/products'){
    requirePermission(user,'inventory.write');const data=await json(req),sku=sanitize(data.sku,70).toUpperCase(),name=sanitize(data.name,160),merchantId=data.merchantId||null;
    if(merchantId&&!stmt('SELECT 1 FROM merchants WHERE id=? AND company_id=?',merchantId,companyId))throw fail(400,'Marchand invalide');
    if(!/^[A-Z0-9_-]{2,70}$/.test(sku)||!name)throw fail(400,'SKU et nom requis');
    const productId=id();
    try{run('INSERT INTO inventory_products VALUES(?,?,?,?,?,?)',productId,companyId,sku,name,merchantId,now());}
    catch(e){if(String(e).includes('UNIQUE'))throw fail(409,'SKU déjà utilisé');throw e;}
    audit(companyId,user.id,'PRODUCT_CREATED','product',productId,{sku});return send(res,201,{id:productId});
   }
   if(method==='POST'&&path==='/api/inventory/receive'){
    requirePermission(user,'inventory.write');const data=await json(req),productId=sanitize(data.productId,40),qty=Number(data.quantity),location=sanitize(data.location,70)||'ENTREPOT';
    if(!Number.isSafeInteger(qty)||qty<1||qty>1000000)throw fail(400,'Quantité invalide');
    if(!stmt('SELECT 1 FROM inventory_products WHERE id=? AND company_id=?',productId,companyId))throw fail(404,'Produit introuvable');
    const lotId=id();tx(()=>{run('INSERT INTO stock_lots(id,company_id,product_id,received_at,quantity_on_hand,location) VALUES (?,?,?,?,?,?)',lotId,companyId,productId,now(),qty,location);audit(companyId,user.id,'STOCK_RECEIVED','stock_lot',lotId,{qty,productId});});
    return send(res,201,{lotId,quantity:qty});
   }
   if(method==='POST'&&path==='/api/inventory/reserve'){
    requirePermission(user,'inventory.write');const data=await json(req),qty=Number(data.quantity),productId=sanitize(data.productId,40),shipId=sanitize(data.shipmentId,40);
    if(!Number.isSafeInteger(qty)||qty<1||qty>1000000)throw fail(400,'Quantité invalide');
    const shipment=stmt('SELECT id,status FROM shipments WHERE id=? AND company_id=?',shipId,companyId);
    if(!shipment)throw fail(404,'Colis introuvable');
    if(!['CREATED','ASSIGNED_AGENCY','EXPORTED'].includes(shipment.status))throw fail(409,'Colis clôturé');
    const stockProduct=stmt('SELECT merchant_id FROM inventory_products WHERE id=? AND company_id=?',productId,companyId);
    if(!stockProduct)throw fail(404,'Produit introuvable');
    const targetMerchant=stmt('SELECT merchant_id FROM shipments WHERE id=? AND company_id=?',shipId,companyId);
    if(stockProduct.merchant_id&&targetMerchant?.merchant_id!==stockProduct.merchant_id)throw fail(403,'Stock associé à un autre marchand');
    const allocated=tx(()=>{
      const lots=all('SELECT id,quantity_on_hand,quantity_reserved FROM stock_lots WHERE company_id=? AND product_id=? AND quantity_on_hand>quantity_reserved ORDER BY received_at,id',companyId,productId);
      if(lots.reduce((sum,l)=>sum+l.quantity_on_hand-l.quantity_reserved,0)<qty)throw fail(409,'Stock insuffisant');
      let left=qty;for(const lot of lots){if(left===0)break;const take=Math.min(left,lot.quantity_on_hand-lot.quantity_reserved);
       run('UPDATE stock_lots SET quantity_reserved=quantity_reserved+? WHERE id=? AND company_id=?',take,lot.id,companyId);
       run('INSERT INTO stock_allocations VALUES (?,?,?,?,?,?,?,?)',id(),companyId,shipId,productId,lot.id,take,'RESERVED',now());left-=take;
      }
      run("UPDATE shipments SET order_source='STOCK' WHERE id=? AND company_id=?",shipId,companyId);
      audit(companyId,user.id,'STOCK_RESERVED','shipment',shipId,{productId,quantity:qty});return qty;
    });return send(res,201,{reserved:allocated});
   }
   if(method==='POST'&&path==='/api/inventory/dispatch')throw fail(410,'La sortie du stock se confirme au scan ramassage');
   throw fail(404,'Route introuvable');
  }catch(e){const status=e.status||500; if(status===500)console.error('Internal error:',e);return send(res,status,{error:status===500?'Erreur serveur':e.message});}
 }
 const server=http.createServer(handler);
 return {server,db};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3000);
 if(host!=='127.0.0.1'&&host!=='localhost'&&(!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32)){
  console.error('Set a strong SESSION_SECRET before external hosting');process.exit(1);
 }
 const secret=process.env.SESSION_SECRET||randomBytes(40).toString('hex');
 if(!process.env.SESSION_SECRET)console.warn('Ephemeral session secret: sessions reset on restart. Do not use in production.');
 const {server}=buildServer({db:openDb(),sessionSecret:secret});server.listen(port,host,()=>console.log(`TransitFlow Delivery listening at http://${host}:${port}`));
}
