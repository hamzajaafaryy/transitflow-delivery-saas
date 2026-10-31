import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDb, now, id } from './db.mjs';
import { hashPassword, verifyPassword, signToken, verifyToken, makeKey, hashKey } from './auth.mjs';
import { STATUSES, STATUS_LABELS, canTransition, canPartnerTransition, mapPartnerStatus, validTracking, centimes } from './domain.mjs';
import { xlsx, orderColumns, parseCsv, rowsToOrders } from './excel.mjs';
import { ticketHtml, publicTrackingHtml } from './ticket.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../public');
const roles={ADMIN:['*'],OPERATIONS:['shipments','partners','imports','export','users.read'],DRIVER:['driver'],MERCHANT:['merchant'],FINANCE:['shipments.read','finance']};
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const allowedCities=x=>Array.isArray(x)?x.map(s=>String(s).trim()).filter(Boolean).slice(0,40):String(x||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,40);
const sanitize=(s,len=160)=>String(s||'').trim().slice(0,len);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const isUuid=s=>/^[a-f0-9-]{36}$/.test(String(s));
const utf8=new TextDecoder('utf-8',{fatal:true});
const mregex=(path,re)=>path.match(re);

export function buildServer({db=openDb(':memory:'),sessionSecret=process.env.SESSION_SECRET||randomBytes(40).toString('hex'),secureCookies=process.env.COOKIE_SECURE==='true',sameOrigin=process.env.PUBLIC_BASE_URL||'http://localhost:3000'}={}){
 const loginAttempts=new Map();
 const stmt=(q,...args)=>db.prepare(q).get(...args);
 const all=(q,...args)=>db.prepare(q).all(...args);
 const run=(q,...args)=>db.prepare(q).run(...args);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 const audit=(tenant,actor,action,entity,entityId,details={})=>run('INSERT INTO audit_logs VALUES (?,?,?,?,?,?,?,?)',id(),tenant,actor,action,entity,entityId,JSON.stringify(details),now());
 function send(res,status,data,headers={}){const text=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(text);}
 async function body(req,max=1024*1024){const chunks=[];let total=0;for await(const chunk of req){total+=chunk.length;if(total>max)throw fail(413,'Fichier trop volumineux');chunks.push(chunk);}return Buffer.concat(chunks);}
 async function json(req){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw fail(415,'Content-Type JSON requis');try{return JSON.parse(utf8.decode(await body(req)));}catch(e){if(e.status)throw e;throw fail(400,'JSON invalide');}}
 function requireSession(req){
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('dn_session='))?.slice(11);
  const data=verifyToken(cookie,sessionSecret);if(!data)throw fail(401,'Connexion requise');
  const user=stmt('SELECT id,tenant_id,full_name,email,role,merchant_id,active FROM users WHERE id=? AND tenant_id=?',data.uid,data.tid);
  if(!user||!user.active)throw fail(401,'Session invalide');return user;
 }
 function permit(user,permission){if(!roles[user.role]?.includes('*')&&!roles[user.role]?.includes(permission))throw fail(403,'Accès interdit');}
 function origin(req){
  if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return;
  // API partner credentials have no browser cookie and are handled separately.
  if(req.url.startsWith('/api/integrations/'))return;
  const actual=req.headers.origin;
  if(actual){const expected=new URL(sameOrigin).origin;if(actual!==expected)throw fail(403,'Origine non autorisée');}
  if(req.headers['x-requested-with']!=='delivery-ui')throw fail(403,'En-tête anti-CSRF requis');
 }
 function createShipment(user,data){
  const tracking=sanitize(data.tracking||`DN${randomBytes(8).toString('hex').toUpperCase()}`,64).toUpperCase();
  if(!validTracking(tracking))throw fail(400,'Tracking invalide');
  const recipient=sanitize(data.recipient),phone=sanitize(data.phone,35),city=sanitize(data.city,90),address=sanitize(data.address,400),description=sanitize(data.description,250);
  if(!recipient||!phone||!city||!address)throw fail(400,'Champs commande manquants');
  const cod=centimes(data.cod??0),partnerId=data.partnerId||null,merchantId=data.merchantId||null,driverId=data.driverId||null;
  if(partnerId&&driverId)throw fail(400,'Un colis ne peut pas être attribué à un partenaire et à un livreur interne simultanément');
  if(partnerId&&!stmt('SELECT 1 FROM partners WHERE id=? AND tenant_id=?',partnerId,user.tenant_id))throw fail(400,'Partenaire invalide');
  if(merchantId&&!stmt('SELECT 1 FROM merchants WHERE id=? AND tenant_id=?',merchantId,user.tenant_id))throw fail(400,'Marchand invalide');
  if(driverId&&!stmt("SELECT 1 FROM users WHERE id=? AND tenant_id=? AND role='DRIVER'",driverId,user.tenant_id))throw fail(400,'Livreur invalide');
  const t=now(),shipId=id(),status=partnerId?'ASSIGNED_PARTNER':'CREATED';
  try{run(`INSERT INTO shipments(id,tenant_id,tracking,merchant_id,partner_id,driver_id,recipient,phone,city,address,description,cod_centimes,status,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,shipId,user.tenant_id,tracking,merchantId,partnerId,driverId,recipient,phone,city,address,description,cod,status,t,t);
  }catch(e){if(String(e).includes('UNIQUE'))throw fail(409,`Tracking dupliqué: ${tracking}`);throw e;}
  run('INSERT INTO shipment_events(id,tenant_id,shipment_id,status,source,actor_id,created_at) VALUES(?,?,?,?,?,?,?)',id(),user.tenant_id,shipId,status,'INTERNAL',user.id,t);
  return {id:shipId,tracking,status};
 }
 function changeStatus(user,shipId,status,source,note='',externalEventId=null,externalStatus=null){
  const sh=stmt('SELECT * FROM shipments WHERE id=? AND tenant_id=?',shipId,user.tenant_id);
  if(!sh)throw fail(404,'Colis introuvable');
  if(!STATUSES.includes(status)||!canTransition(sh.status,status))throw fail(409,`Transition invalide ${sh.status} → ${status}`);
  if(sh.status===status)return {tracking:sh.tracking,status:sh.status,unchanged:true};
  const t=now();
  if(status==='CANCELLED'){
   const reserved=all("SELECT id,lot_id,quantity FROM stock_allocations WHERE tenant_id=? AND shipment_id=? AND state='RESERVED'",user.tenant_id,sh.id);
   for(const a of reserved){run('UPDATE stock_lots SET quantity_reserved=quantity_reserved-? WHERE id=? AND tenant_id=?',a.quantity,a.lot_id,user.tenant_id);run("UPDATE stock_allocations SET state='RELEASED' WHERE id=? AND tenant_id=?",a.id,user.tenant_id);}
  }
  run('UPDATE shipments SET status=?,updated_at=?,delivered_at=CASE WHEN ?=\'DELIVERED\' THEN ? ELSE delivered_at END,external_status=COALESCE(?,external_status),external_updated_at=CASE WHEN ? IS NULL THEN external_updated_at ELSE ? END WHERE id=? AND tenant_id=?',status,t,status,t,externalStatus,externalStatus,t,sh.id,user.tenant_id);
  run('INSERT INTO shipment_events(id,tenant_id,shipment_id,status,source,external_event_id,note,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',id(),user.tenant_id,sh.id,status,source,externalEventId,sanitize(note,400),user.id||null,t);
  audit(user.tenant_id,user.id||null,'STATUS_CHANGE','shipment',sh.id,{from:sh.status,to:status,source});
  return {tracking:sh.tracking,status,updatedAt:t};
 }
 async function handler(req,res){
  const url=new URL(req.url,'http://localhost');const path=url.pathname,method=req.method;
  res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try{
   if(method==='GET'&&path==='/api/health')return send(res,200,{ok:true,service:'delivery-network-saas',version:'0.1.0'});
   if(method==='GET'&&mregex(path,/^\/api\/tracking\/([a-zA-Z0-9_-]{4,64})$/)){
    const tracking=decodeURIComponent(path.split('/').at(-1));
    const record=stmt('SELECT id,tracking,status,city,created_at,updated_at FROM shipments WHERE tracking=? COLLATE NOCASE',tracking);
    // Multiple tenants may use the same custom code: do not leak or mix data.
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
    const partner=stmt('SELECT * FROM partners WHERE api_key_hash=?',hashKey(key));
    if(!partner)throw fail(401,'Clé API invalide');
    const data=await json(req);const eventId=sanitize(data.eventId,100),tracking=sanitize(data.tracking,64),externalStatus=sanitize(data.status,100),externalTracking=sanitize(data.externalTracking,100);
    if(!eventId||!tracking||!externalStatus)throw fail(400,'eventId, tracking, status requis');
    const sh=stmt('SELECT * FROM shipments WHERE tenant_id=? AND partner_id=? AND (tracking=? OR external_tracking=?)',partner.tenant_id,partner.id,tracking,tracking);
    if(!sh)throw fail(404,'Colis non affecté à ce partenaire');
    if(stmt('SELECT 1 FROM shipment_events WHERE tenant_id=? AND source=? AND external_event_id=?',partner.tenant_id,`PARTNER:${partner.id}`,eventId))return send(res,200,{ok:true,duplicate:true,status:sh.status});
    const mapped=mapPartnerStatus(externalStatus,JSON.parse(partner.status_map));
    if(!mapped)throw fail(422,'Statut externe non configuré');
    // Prevent upstream from asserting internal-only lifecycle transitions.
    if(['CREATED','EXPORTED','ASSIGNED_PARTNER','CANCELLED'].includes(mapped))throw fail(422,'Statut non autorisé pour API partenaire');
    const result=tx(()=>{
      const current=stmt('SELECT * FROM shipments WHERE id=? AND tenant_id=?',sh.id,partner.tenant_id);
      if(!canPartnerTransition(current.status,mapped))throw fail(409,`Transition invalide ${current.status} → ${mapped}`);
      const t=now();
      run('UPDATE shipments SET status=?, external_status=?,external_tracking=COALESCE(NULLIF(?,\'\'),external_tracking),external_updated_at=?,updated_at=?,delivered_at=CASE WHEN ?=\'DELIVERED\' THEN ? ELSE delivered_at END,handed_over_at=CASE WHEN ?=\'PICKED_UP\' THEN COALESCE(handed_over_at,?) ELSE handed_over_at END WHERE id=? AND tenant_id=?',mapped,externalStatus,externalTracking,t,t,mapped,t,mapped,t,current.id,partner.tenant_id);
      run('INSERT INTO shipment_events(id,tenant_id,shipment_id,status,source,external_event_id,note,created_at) VALUES (?,?,?,?,?,?,?,?)',id(),partner.tenant_id,current.id,mapped,`PARTNER:${partner.id}`,eventId,`External: ${externalStatus}`,t);
      audit(partner.tenant_id,null,'PARTNER_SYNC','shipment',current.id,{partnerId:partner.id,eventId,from:current.status,to:mapped});
      return {ok:true,tracking:current.tracking,status:mapped};
    });return send(res,200,result);
   }
   if(method==='GET'&&!path.startsWith('/api/')){
    const assets={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/manifest.webmanifest':'manifest.webmanifest'};
    const filename=assets[path];if(!filename)throw fail(404,'Page introuvable');
    const data=readFileSync(resolve(root,filename));res.writeHead(200,{'Content-Type':mime[extname(filename)]||'application/manifest+json','Cache-Control':'no-store'});return res.end(data);
   }
   origin(req);
   if(method==='POST'&&path==='/api/auth/register'){
    const data=await json(req),name=sanitize(data.companyName),slug=sanitize(data.slug,40).toLowerCase(),email=sanitize(data.email,200).toLowerCase(),fullName=sanitize(data.fullName,120);
    if(!name||!fullName||!/^[a-z0-9-]{3,40}$/.test(slug)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw fail(400,'Informations invalides');
    const hash=hashPassword(data.password),tenant=id(),uid=id(),t=now();
    try{tx(()=>{run('INSERT INTO companies VALUES(?,?,?,?,?)',tenant,slug,name,'STARTER',t);run('INSERT INTO users(id,tenant_id,full_name,email,password_hash,role,merchant_id,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)',uid,tenant,fullName,email,hash,'ADMIN',null,1,t);audit(tenant,uid,'COMPANY_CREATED','company',tenant);});}
    catch(e){if(String(e).includes('UNIQUE'))throw fail(409,'Code entreprise déjà utilisé');throw e;}
    return send(res,201,{ok:true,company:slug});
   }
   if(method==='POST'&&path==='/api/auth/login'){
    const data=await json(req),slug=sanitize(data.company,40).toLowerCase(),email=sanitize(data.email,200).toLowerCase();
    const key=`${req.socket.remoteAddress}:${slug}:${email}`;const previous=loginAttempts.get(key)||{count:0,until:0};
    if(previous.until>Date.now())throw fail(429,'Trop de tentatives');
    const user=stmt('SELECT u.*,c.slug FROM users u JOIN companies c ON c.id=u.tenant_id WHERE c.slug=? AND u.email=?',slug,email);
    if(!user||!user.active||!verifyPassword(data.password,user.password_hash)){
     const count=previous.count+1;loginAttempts.set(key,{count,until:count>=8?Date.now()+900000:0});throw fail(401,'Identifiants incorrects');
    }
    loginAttempts.delete(key);
    const cookie=`dn_session=${signToken({uid:user.id,tid:user.tenant_id},sessionSecret)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=28800${secureCookies?'; Secure':''}`;
    return send(res,200,{ok:true,role:user.role,name:user.full_name},{'Set-Cookie':cookie});
   }
   if(method==='POST'&&path==='/api/auth/logout')return send(res,200,{ok:true},{'Set-Cookie':`dn_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secureCookies?'; Secure':''}`});
   const user=requireSession(req);
   const tenant=user.tenant_id;
   if(method==='GET'&&path==='/api/me'){
    const company=stmt('SELECT slug,name,plan FROM companies WHERE id=?',tenant);
    return send(res,200,{user,company,permissions:roles[user.role],statusLabels:STATUS_LABELS});
   }
   if(method==='GET'&&path==='/api/stats'){
    const clause=user.role==='DRIVER'?' AND driver_id=?':user.role==='MERCHANT'?' AND merchant_id=?':'';
    const args=user.role==='DRIVER'?[tenant,user.id]:user.role==='MERCHANT'?[tenant,user.merchant_id||'NO_MERCHANT']:[tenant];
    const rows=all('SELECT status,COUNT(*) AS n FROM shipments WHERE tenant_id=?'+clause+' GROUP BY status',...args),total=rows.reduce((s,x)=>s+x.n,0);
    const cod=stmt("SELECT COALESCE(SUM(cod_centimes),0) AS value FROM shipments WHERE tenant_id=?"+clause+" AND status='DELIVERED'",...args).value;
    return send(res,200,{total,byStatus:Object.fromEntries(rows.map(x=>[x.status,x.n])),deliveredCodCentimes:cod,partners:['MERCHANT','DRIVER'].includes(user.role)?0:stmt('SELECT COUNT(*) AS n FROM partners WHERE tenant_id=?',tenant).n});
   }
   if(method==='GET'&&path==='/api/shipments'){
    const status=sanitize(url.searchParams.get('status'),30),search=sanitize(url.searchParams.get('q'),100);
    const filter=[tenant],where=['s.tenant_id=?'];
    if(user.role==='DRIVER'){where.push('s.driver_id=?');filter.push(user.id);}
    if(user.role==='MERCHANT'){where.push('s.merchant_id=?');filter.push(user.merchant_id||'NO_MERCHANT');}
    if(status){where.push('s.status=?');filter.push(status);}
    if(search){where.push('(s.tracking LIKE ? OR s.recipient LIKE ?)');filter.push(`%${search}%`,`%${search}%`);}
    const records=all(`SELECT s.*,p.name AS partner_name,u.full_name AS driver_name,m.name AS merchant_name,
     EXISTS(SELECT 1 FROM ledger l WHERE l.shipment_id=s.id AND l.tenant_id=s.tenant_id AND l.type='COD_COLLECTED') AS cod_collected
     FROM shipments s LEFT JOIN partners p ON p.id=s.partner_id AND p.tenant_id=s.tenant_id
     LEFT JOIN users u ON u.id=s.driver_id AND u.tenant_id=s.tenant_id
     LEFT JOIN merchants m ON m.id=s.merchant_id AND m.tenant_id=s.tenant_id
     WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT 300`,...filter);
    return send(res,200,{shipments:records});
   }
   if(method==='POST'&&path==='/api/shipments'){
    permit(user,'shipments');const data=await json(req);return send(res,201,tx(()=>createShipment(user,data)));
   }
   // Details, ticket and notes are tenant-scoped and role-scoped (never public).
   const detailsMatch=mregex(path,/^\/api\/shipments\/([a-f0-9-]{36})(?:\/(ticket|notes))?$/);
   if(detailsMatch){
    const sh=stmt(`SELECT s.*,p.name AS partner_name,m.name AS merchant_name,u.full_name AS driver_name
      FROM shipments s LEFT JOIN partners p ON p.id=s.partner_id AND p.tenant_id=s.tenant_id
      LEFT JOIN merchants m ON m.id=s.merchant_id AND m.tenant_id=s.tenant_id
      LEFT JOIN users u ON u.id=s.driver_id AND u.tenant_id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=?`,detailsMatch[1],tenant);
    if(!sh)throw fail(404,'Colis introuvable');
    if(user.role==='DRIVER'&&(sh.driver_id!==user.id||sh.partner_id))throw fail(403,'Accès interdit');
    if(user.role==='MERCHANT'&&(!user.merchant_id||sh.merchant_id!==user.merchant_id))throw fail(403,'Accès interdit');
    if(method==='GET'&&!detailsMatch[2]){
      const events=all(`SELECT e.status,e.source,e.note,e.created_at,u.full_name AS actor_name
        FROM shipment_events e LEFT JOIN users u ON u.id=e.actor_id AND u.tenant_id=e.tenant_id
        WHERE e.shipment_id=? AND e.tenant_id=? ORDER BY e.created_at,e.rowid`,sh.id,tenant);
      const notes=['ADMIN','OPERATIONS'].includes(user.role)?all(`SELECT n.message,n.created_at,u.full_name AS author
         FROM shipment_notes n JOIN users u ON u.id=n.actor_id AND u.tenant_id=n.tenant_id
         WHERE n.shipment_id=? AND n.tenant_id=? ORDER BY n.created_at,n.rowid`,sh.id,tenant):[];
      const paid=stmt("SELECT COUNT(*) AS n FROM ledger WHERE shipment_id=? AND tenant_id=? AND type='COD_COLLECTED'",sh.id,tenant).n>0;
      return send(res,200,{shipment:sh,events,notes,codCollectionConfirmed:paid});
    }
    if(method==='GET'&&detailsMatch[2]==='ticket'){
      if(!['ADMIN','OPERATIONS','DRIVER','MERCHANT'].includes(user.role))throw fail(403,'Accès interdit');
      const company=stmt('SELECT name FROM companies WHERE id=?',tenant);
      const publicBase=new URL(sameOrigin);
      const trackingUrl=`${publicBase.origin}/suivi/${encodeURIComponent(sh.tracking)}`;
      const html=ticketHtml({shipment:sh,company,merchantName:sh.merchant_name,partnerName:sh.partner_name,trackingUrl});
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);
    }
    if(method==='POST'&&detailsMatch[2]==='notes'){
      permit(user,'shipments');const data=await json(req),message=sanitize(data.message,400);
      if(message.length<2)throw fail(400,'Commentaire requis');
      const noteId=id();tx(()=>{run('INSERT INTO shipment_notes VALUES(?,?,?,?,?,?)',noteId,tenant,sh.id,user.id,message,now());audit(tenant,user.id,'SHIPMENT_NOTE','shipment',sh.id,{noteId});});
      return send(res,201,{id:noteId,ok:true});
    }
    if(method==='PATCH'&&!detailsMatch[2]){
      permit(user,'shipments');
      if(['DELIVERED','RETURNED','CANCELLED'].includes(sh.status))throw fail(409,'Colis clôturé');
      const data=await json(req);
      const allowed=['recipient','phone','city','address','description','cod'];
      const fields=Object.keys(data).filter(x=>x!=='reason');
      if(!fields.length||fields.some(x=>!allowed.includes(x)))throw fail(400,'Champs invalides');
      const reason=sanitize(data.reason,200);
      if(reason.length<5)throw fail(400,'Motif de modification requis');
      if(fields.includes('cod')&&user.role!=='ADMIN')throw fail(403,'Modification COD réservée à Admin');
      if(fields.includes('cod')&&stmt("SELECT 1 FROM ledger WHERE tenant_id=? AND shipment_id=? AND type='COD_COLLECTED'",tenant,sh.id))throw fail(409,'COD déjà collecté');
      const max={recipient:160,phone:35,city:90,address:400,description:250};
      const next={};for(const f of fields){const value=f==='cod'?centimes(data.cod):sanitize(data[f],max[f]);if(f!=='description'&&f!=='cod'&&!value)throw fail(400,`Champ requis : ${f}`);next[f==='cod'?'cod_centimes':f]=value;}
      const changed=Object.fromEntries(Object.entries(next).filter(([k,v])=>v!==sh[k]));
      if(!Object.keys(changed).length)return send(res,200,{ok:true,unchanged:true});
      const externalPending=Boolean(sh.partner_id&&['EXPORTED','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','POSTPONED','REFUSED'].includes(sh.status));
      tx(()=>{
        const keys=Object.keys(changed),values=Object.values(changed);
        run(`UPDATE shipments SET ${keys.map(k=>`${k}=?`).join(',')},pending_partner_update=CASE WHEN ? THEN 1 ELSE pending_partner_update END,updated_at=? WHERE id=? AND tenant_id=?`,...values,externalPending?1:0,now(),sh.id,tenant);
        audit(tenant,user.id,'SHIPMENT_EDIT','shipment',sh.id,{fields:keys,reason,before:Object.fromEntries(keys.map(k=>[k,sh[k]])),after:changed,externalPending});
      });
      return send(res,200,{ok:true,pendingPartnerUpdate:externalPending||Boolean(sh.pending_partner_update)});
    }
   }
   const statusMatch=mregex(path,/^\/api\/shipments\/([a-f0-9-]{36})\/status$/);
   if(method==='POST'&&statusMatch){
    const sh=stmt('SELECT * FROM shipments WHERE id=? AND tenant_id=?',statusMatch[1],tenant);
    if(!sh)throw fail(404,'Colis introuvable');
    if(user.role==='DRIVER'){if(sh.driver_id!==user.id||sh.partner_id)throw fail(403,'Colis non attribué');}
    else permit(user,'shipments');
    const data=await json(req);if(!STATUSES.includes(data.status))throw fail(400,'Statut inconnu');
    if(user.role==='DRIVER'&&!['OUT_FOR_DELIVERY','DELIVERED','REFUSED','POSTPONED'].includes(data.status))throw fail(403,'Statut interdit au livreur');
    return send(res,200,tx(()=>changeStatus(user,sh.id,data.status,'INTERNAL',data.note)));
   }
   if(method==='POST'&&path==='/api/shipments/assign'){
    permit(user,'shipments');const data=await json(req);
    const sh=stmt('SELECT * FROM shipments WHERE id=? AND tenant_id=?',data.shipmentId,tenant);
    if(!sh)throw fail(404,'Colis introuvable');
    if(sh.status==='DELIVERED'||sh.status==='RETURNED')throw fail(409,'Colis terminé');
    if(data.partnerId&&data.driverId)throw fail(400,'Choisir partenaire ou livreur');
    if(!['CREATED','ASSIGNED_PARTNER','EXPORTED'].includes(sh.status))throw fail(409,'Affectation non autorisée à cette étape');
    if(data.partnerId&&!stmt('SELECT 1 FROM partners WHERE tenant_id=? AND id=?',tenant,data.partnerId))throw fail(400,'Partenaire invalide');
    if(data.driverId&&!stmt("SELECT 1 FROM users WHERE tenant_id=? AND id=? AND role='DRIVER'",tenant,data.driverId))throw fail(400,'Livreur invalide');
    tx(()=>{const newStatus=data.partnerId?'ASSIGNED_PARTNER':data.driverId&&sh.status==='CREATED'?'IN_TRANSIT':sh.status;const t=now();run('UPDATE shipments SET partner_id=?,driver_id=?,status=?,updated_at=? WHERE id=? AND tenant_id=?',data.partnerId||null,data.driverId||null,newStatus,t,sh.id,tenant);if(sh.status!==newStatus)run('INSERT INTO shipment_events(id,tenant_id,shipment_id,status,source,actor_id,note,created_at) VALUES(?,?,?,?,?,?,?,?)',id(),tenant,sh.id,newStatus,'INTERNAL',user.id,'Affectation',t);audit(tenant,user.id,'SHIPMENT_ASSIGN','shipment',sh.id,{partnerId:data.partnerId,driverId:data.driverId});});
    return send(res,200,{ok:true});
   }
   if(method==='GET'&&path==='/api/partners'){
    permit(user,'partners');return send(res,200,{partners:all('SELECT id,name,cities,contact,fee_centimes,created_at FROM partners WHERE tenant_id=? ORDER BY name',tenant).map(p=>({...p,cities:JSON.parse(p.cities)}))});
   }
   if(method==='POST'&&path==='/api/partners'){
    permit(user,'partners');const data=await json(req),name=sanitize(data.name,120),cities=allowedCities(data.cities),contact=sanitize(data.contact,120),fee=centimes(data.fee??0);
    if(!name||cities.length===0)throw fail(400,'Nom et villes requis');
    const partnerId=id(),key=makeKey();
    try{tx(()=>{run('INSERT INTO partners(id,tenant_id,name,cities,contact,fee_centimes,api_key_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',partnerId,tenant,name,JSON.stringify(cities),contact,fee,hashKey(key),now());audit(tenant,user.id,'PARTNER_CREATED','partner',partnerId,{name,cities});});}
    catch(e){if(String(e).includes('UNIQUE'))throw fail(409,'Partenaire existant');throw e;}
    return send(res,201,{id:partnerId,name,apiKey:key,warning:'Copiez cette clé maintenant. Elle ne sera plus affichée.'});
   }
   if(method==='GET'&&path==='/api/users'){
    permit(user,'users.read');return send(res,200,{users:all('SELECT id,full_name,email,role,merchant_id,active FROM users WHERE tenant_id=? ORDER BY full_name',tenant)});
   }
   if(method==='POST'&&path==='/api/users'){
    permit(user,'*');const data=await json(req),name=sanitize(data.name,100),email=sanitize(data.email,180).toLowerCase(),role=data.role;
    if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['OPERATIONS','DRIVER','MERCHANT','FINANCE'].includes(role))throw fail(400,'Utilisateur invalide');
    const merchantId=role==='MERCHANT'?sanitize(data.merchantId,40):null;
    if(role==='MERCHANT'&&!stmt('SELECT 1 FROM merchants WHERE tenant_id=? AND id=?',tenant,merchantId))throw fail(400,'Marchand invalide');
    const hash=hashPassword(data.password);const uid=id();
    try{run('INSERT INTO users(id,tenant_id,full_name,email,password_hash,role,merchant_id,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)',uid,tenant,name,email,hash,role,merchantId,1,now());}
    catch(e){if(String(e).includes('UNIQUE'))throw fail(409,'Email existant');throw e;}
    audit(tenant,user.id,'USER_CREATED','user',uid,{role});return send(res,201,{id:uid});
   }
   if(method==='GET'&&path==='/api/merchants'){
    permit(user,'shipments');return send(res,200,{merchants:all('SELECT id,name,phone FROM merchants WHERE tenant_id=? ORDER BY name',tenant)});
   }
   if(method==='POST'&&path==='/api/merchants'){
    permit(user,'shipments');const data=await json(req),name=sanitize(data.name,120);if(!name)throw fail(400,'Nom requis');
    const mid=id();run('INSERT INTO merchants VALUES(?,?,?,?,?)',mid,tenant,name,sanitize(data.phone,35),now());return send(res,201,{id:mid});
   }
   if(method==='POST'&&path==='/api/import/orders'){
    permit(user,'imports');const contentType=req.headers['content-type']||'';if(!/(text\/csv|application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet|application\/octet-stream)/.test(contentType))throw fail(415,'Importer CSV ou XLSX');
    const raw=await body(req,4_000_000),rows=contentType.includes('text/csv')?parseCsv(utf8.decode(raw).replace(/^\uFEFF/,'')):xlsx('import',raw);
    if(rows.length>1001)throw fail(413,'Maximum 1000 commandes par import');
    const orders=rowsToOrders(rows);let inserted=0,skipped=0;const errors=[];
    tx(()=>{for(const order of orders){try{createShipment(user,order);inserted++;}catch(e){skipped++;errors.push({line:order.line,error:e.message});}}
      run('INSERT INTO imports VALUES (?,?,?,?,?,?,?)',id(),tenant,user.id,inserted,skipped,sanitize(req.headers['x-filename']||'import.xlsx',120),now());
      audit(tenant,user.id,'ORDERS_IMPORT','import',null,{inserted,skipped});});
    return send(res,200,{inserted,skipped,errors:errors.slice(0,100)});
   }
   const exportMatch=mregex(path,/^\/api\/partners\/([a-f0-9-]{36})\/export$/);
   if(method==='POST'&&exportMatch){
    permit(user,'export');const partner=stmt('SELECT * FROM partners WHERE id=? AND tenant_id=?',exportMatch[1],tenant);if(!partner)throw fail(404,'Partenaire introuvable');
    const shipments=all("SELECT * FROM shipments WHERE tenant_id=? AND partner_id=? AND status IN ('ASSIGNED_PARTNER','EXPORTED') ORDER BY created_at LIMIT 1000",tenant,partner.id);
    if(!shipments.length)throw fail(409,'Aucun colis à exporter');
    const rows=[orderColumns,...shipments.map(s=>[s.tracking,s.recipient,s.phone,s.address,s.city,(s.cod_centimes/100).toFixed(2),s.description])];
    const content=xlsx('export',rows);const ref=`MAN-${Date.now()}-${randomBytes(3).toString('hex')}`;
    tx(()=>{
     const mid=id(),t=now();run('INSERT INTO manifests VALUES(?,?,?,?,?,?,?)',mid,tenant,partner.id,ref,shipments.length,user.id,t);
     for(const s of shipments){run('INSERT INTO manifest_shipments VALUES(?,?,?)',tenant,mid,s.id);
      if(s.status==='ASSIGNED_PARTNER'){
       run("UPDATE shipments SET status='EXPORTED',exported_at=?,updated_at=? WHERE id=? AND tenant_id=?",t,t,s.id,tenant);
       run('INSERT INTO shipment_events(id,tenant_id,shipment_id,status,source,actor_id,note,created_at) VALUES(?,?,?,?,?,?,?,?)',id(),tenant,s.id,'EXPORTED','INTERNAL',user.id,ref,t);
      }
     }
     audit(tenant,user.id,'MANIFEST_EXPORTED','manifest',mid,{partnerId:partner.id,count:shipments.length});
    });
    res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${ref}.xlsx"`,'X-Manifest-Reference':ref,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(content);
   }
   if(method==='GET'&&path==='/api/manifests'){
    permit(user,'export');return send(res,200,{manifests:all('SELECT m.*,p.name AS partner_name FROM manifests m JOIN partners p ON p.id=m.partner_id WHERE m.tenant_id=? ORDER BY m.created_at DESC LIMIT 100',tenant)});
   }
   if(method==='POST'&&path==='/api/ledger/collect'){
    permit(user,'finance');const data=await json(req),sh=stmt('SELECT * FROM shipments WHERE id=? AND tenant_id=?',data.shipmentId,tenant);
    if(!sh)throw fail(404,'Colis introuvable');if(sh.status!=='DELIVERED')throw fail(409,'Livraison non confirmée');
    if(sh.cod_centimes===0)throw fail(409,'Aucun COD à collecter');
    try{tx(()=>{run('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)',id(),tenant,sh.id,'COD_COLLECTED',sh.cod_centimes,'Collecte confirmée manuellement',user.id,now());audit(tenant,user.id,'COD_COLLECTED','shipment',sh.id,{amount:sh.cod_centimes});});}
    catch(e){if(String(e).includes('UNIQUE'))throw fail(409,'COD déjà enregistré');throw e;}
    return send(res,201,{ok:true,amountCentimes:sh.cod_centimes});
   }
   if(method==='GET'&&path==='/api/ledger'){
    permit(user,'finance');return send(res,200,{entries:all('SELECT l.*,s.tracking FROM ledger l JOIN shipments s ON s.id=l.shipment_id AND s.tenant_id=l.tenant_id WHERE l.tenant_id=? ORDER BY l.created_at DESC LIMIT 150',tenant)});
   }
   if(method==='GET'&&path==='/api/billing/usage'){
    permit(user,'*');
    const month=sanitize(url.searchParams.get('month')||now().slice(0,7),7);
    if(!/^\d{4}-\d{2}$/.test(month))throw fail(400,'Mois invalide');
    const company=stmt('SELECT plan FROM companies WHERE id=?',tenant);
    const created=stmt("SELECT COUNT(*) AS n FROM shipments WHERE tenant_id=? AND substr(created_at,1,7)=?",tenant,month).n;
    const synced=stmt("SELECT COUNT(*) AS n FROM shipment_events WHERE tenant_id=? AND source LIKE 'PARTNER:%' AND substr(created_at,1,7)=?",tenant,month).n;
    const exported=stmt("SELECT COUNT(*) AS n FROM manifests WHERE tenant_id=? AND substr(created_at,1,7)=?",tenant,month).n;
    return send(res,200,{month,plan:company.plan,usage:{shipmentsCreated:created,partnerStatusEvents:synced,excelExports:exported},billingEnabled:false,note:'Tarifs et facturation SaaS non configurés pour le pilote'});
   }
   const mappingMatch=mregex(path,/^\/api\/partners\/([a-f0-9-]{36})\/status-map$/);
   if(method==='POST'&&mappingMatch){
    permit(user,'*');const partner=stmt('SELECT id FROM partners WHERE id=? AND tenant_id=?',mappingMatch[1],tenant);
    if(!partner)throw fail(404,'Partenaire introuvable');
    const data=await json(req),mapping=data.map;
    if(!mapping||typeof mapping!=='object'||Array.isArray(mapping)||Object.keys(mapping).length>40)throw fail(400,'Mapping invalide');
    const clean=Object.create(null);
    for(const [k,v] of Object.entries(mapping)){
      const key=String(k).trim().toUpperCase().replace(/[\s-]+/g,'_');
      if(!/^[A-ZÀ-Ÿ0-9_]{1,70}$/.test(key)||!STATUSES.includes(v))throw fail(400,'Entrée mapping invalide');
      clean[key]=v;
    }
    run('UPDATE partners SET status_map=? WHERE tenant_id=? AND id=?',JSON.stringify(clean),tenant,partner.id);
    audit(tenant,user.id,'PARTNER_STATUS_MAP','partner',partner.id,{keys:Object.keys(clean)});
    return send(res,200,{ok:true,mapping:clean});
   }
   const keyMatch=mregex(path,/^\/api\/partners\/([a-f0-9-]{36})\/rotate-key$/);
   if(method==='POST'&&keyMatch){
    permit(user,'*');const partner=stmt('SELECT id FROM partners WHERE id=? AND tenant_id=?',keyMatch[1],tenant);
    if(!partner)throw fail(404,'Partenaire introuvable');
    const newKey=makeKey();tx(()=>{run('UPDATE partners SET api_key_hash=? WHERE tenant_id=? AND id=?',hashKey(newKey),tenant,partner.id);audit(tenant,user.id,'PARTNER_API_KEY_ROTATED','partner',partner.id);});
    return send(res,200,{apiKey:newKey,warning:'Ancienne clé révoquée. Copiez la nouvelle clé maintenant.'});
   }
   if(method==='GET'&&path==='/api/inventory'){
    permit(user,'shipments');
    const products=all(`SELECT p.id,p.sku,p.name,p.merchant_id,
      COALESCE(SUM(l.quantity_on_hand),0) AS on_hand,
      COALESCE(SUM(l.quantity_reserved),0) AS reserved
      FROM inventory_products p LEFT JOIN stock_lots l ON l.product_id=p.id AND l.tenant_id=p.tenant_id
      WHERE p.tenant_id=? GROUP BY p.id ORDER BY p.name`,tenant);
    return send(res,200,{products:products.map(p=>({...p,available:p.on_hand-p.reserved}))});
   }
   if(method==='POST'&&path==='/api/inventory/products'){
    permit(user,'shipments');const data=await json(req),sku=sanitize(data.sku,70).toUpperCase(),name=sanitize(data.name,160);
    if(!/^[A-Z0-9_-]{2,70}$/.test(sku)||!name)throw fail(400,'SKU et nom requis');
    const productId=id();
    try{run('INSERT INTO inventory_products VALUES(?,?,?,?,?,?)',productId,tenant,sku,name,null,now());}
    catch(e){if(String(e).includes('UNIQUE'))throw fail(409,'SKU déjà utilisé');throw e;}
    audit(tenant,user.id,'PRODUCT_CREATED','product',productId,{sku});return send(res,201,{id:productId});
   }
   if(method==='POST'&&path==='/api/inventory/receive'){
    permit(user,'shipments');const data=await json(req),productId=sanitize(data.productId,40),qty=Number(data.quantity),location=sanitize(data.location,70)||'ENTREPOT';
    if(!Number.isSafeInteger(qty)||qty<1||qty>1000000)throw fail(400,'Quantité invalide');
    if(!stmt('SELECT 1 FROM inventory_products WHERE id=? AND tenant_id=?',productId,tenant))throw fail(404,'Produit introuvable');
    const lotId=id();tx(()=>{run('INSERT INTO stock_lots(id,tenant_id,product_id,received_at,quantity_on_hand,location) VALUES (?,?,?,?,?,?)',lotId,tenant,productId,now(),qty,location);audit(tenant,user.id,'STOCK_RECEIVED','stock_lot',lotId,{qty,productId});});
    return send(res,201,{lotId,quantity:qty});
   }
   if(method==='POST'&&path==='/api/inventory/reserve'){
    permit(user,'shipments');const data=await json(req),qty=Number(data.quantity),productId=sanitize(data.productId,40),shipId=sanitize(data.shipmentId,40);
    if(!Number.isSafeInteger(qty)||qty<1||qty>1000000)throw fail(400,'Quantité invalide');
    const shipment=stmt('SELECT id,status FROM shipments WHERE id=? AND tenant_id=?',shipId,tenant);
    if(!shipment)throw fail(404,'Colis introuvable');
    if(!['CREATED','ASSIGNED_PARTNER','EXPORTED'].includes(shipment.status))throw fail(409,'Colis clôturé');
    if(!stmt('SELECT 1 FROM inventory_products WHERE id=? AND tenant_id=?',productId,tenant))throw fail(404,'Produit introuvable');
    const allocated=tx(()=>{
      const lots=all('SELECT id,quantity_on_hand,quantity_reserved FROM stock_lots WHERE tenant_id=? AND product_id=? AND quantity_on_hand>quantity_reserved ORDER BY received_at,id',tenant,productId);
      if(lots.reduce((sum,l)=>sum+l.quantity_on_hand-l.quantity_reserved,0)<qty)throw fail(409,'Stock insuffisant');
      let left=qty;for(const lot of lots){if(left===0)break;const take=Math.min(left,lot.quantity_on_hand-lot.quantity_reserved);
       run('UPDATE stock_lots SET quantity_reserved=quantity_reserved+? WHERE id=? AND tenant_id=?',take,lot.id,tenant);
       run('INSERT INTO stock_allocations VALUES (?,?,?,?,?,?,?,?)',id(),tenant,shipId,productId,lot.id,take,'RESERVED',now());left-=take;
      }
      audit(tenant,user.id,'STOCK_RESERVED','shipment',shipId,{productId,quantity:qty});return qty;
    });return send(res,201,{reserved:allocated});
   }
   if(method==='POST'&&path==='/api/inventory/dispatch'){
    permit(user,'shipments');const data=await json(req),shipId=sanitize(data.shipmentId,40);
    if(!stmt('SELECT 1 FROM shipments WHERE id=? AND tenant_id=?',shipId,tenant))throw fail(404,'Colis introuvable');
    const count=tx(()=>{
      const allocations=all("SELECT * FROM stock_allocations WHERE tenant_id=? AND shipment_id=? AND state='RESERVED'",tenant,shipId);
      if(!allocations.length)throw fail(409,'Aucun produit réservé');
      for(const a of allocations){run('UPDATE stock_lots SET quantity_on_hand=quantity_on_hand-?,quantity_reserved=quantity_reserved-? WHERE id=? AND tenant_id=?',a.quantity,a.quantity,a.lot_id,tenant);
       run("UPDATE stock_allocations SET state='DISPATCHED' WHERE id=? AND tenant_id=?",a.id,tenant);}
      audit(tenant,user.id,'STOCK_DISPATCHED','shipment',shipId,{allocations:allocations.length});return allocations.length;
    });return send(res,200,{dispatchedAllocations:count});
   }
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
 const {server}=buildServer({db:openDb(),sessionSecret:secret});server.listen(port,host,()=>console.log(`Delivery Network SaaS listening at http://${host}:${port}`));
}
