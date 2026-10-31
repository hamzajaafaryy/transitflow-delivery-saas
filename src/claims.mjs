import {id,now} from './db.mjs';
import {has,requirePermission,agencyScoped,requireAgency} from './access.mjs';
import {clean,fail,reference,shipment,merchantId,pickupAccess,notify} from './workflow-shared.mjs';
const categories=['DELAY','DELIVERY','RETURN','STOCK','PAYMENT','DAMAGED','LOST','TECHNICAL','OTHER'];
function ticketAccess(ctx,t){
 if(!t)throw fail(404,'Réclamation introuvable');const {user}=ctx;
 if(user.role==='MERCHANT'){if(t.merchant_id!==user.merchant_id)throw fail(403,'Réclamation d’un autre marchand');}
 else if(['DRIVER','PICKUP_DRIVER'].includes(user.role)){if(t.created_by!==user.id)throw fail(403,'Réclamation hors de votre compte');}
 else {if(!has(user,'claims.manage')&&!has(user,'claims.read')){if(t.created_by!==user.id)throw fail(403,'Réclamation hors de votre compte');return t;}requirePermission(user,'claims.manage','claims.read');if(agencyScoped(user)){if(t.category==='PAYMENT'||!t.shipment_id)throw fail(403,'Réclamation hors périmètre agence');shipment(ctx,t.shipment_id);}}
 return t;
}
function detail(ctx,t){const staff=has(ctx.user,'claims.manage')||has(ctx.user,'claims.read');return {claim:t,messages:ctx.all(`SELECT m.id,m.message,m.internal,m.created_at,u.full_name AS author,u.role FROM claim_messages m JOIN users u ON u.id=m.actor_id AND u.company_id=m.company_id WHERE m.claim_id=? AND m.company_id=?${staff?'':' AND m.internal=0'} ORDER BY m.created_at,m.rowid`,t.id,ctx.companyId),attachments:ctx.all(`SELECT a.id,a.filename,a.mime,a.created_at,length(a.data) AS size FROM claim_attachments a LEFT JOIN claim_messages m ON m.id=a.message_id AND m.company_id=a.company_id WHERE a.claim_id=? AND a.company_id=?${staff?'':' AND COALESCE(m.internal,0)=0'} ORDER BY a.created_at`,t.id,ctx.companyId)};}
export async function claimRoute(ctx){
 const {path,method,user,companyId,stmt,all,run,tx,json,send,res,audit}=ctx;
 requirePermission(user,'claims.create','claims.manage','claims.read');
 if(path==='/api/workflow/claims'){
  if(method==='GET'){
   const where=['c.company_id=?'],args=[companyId];if(user.role==='MERCHANT'){where.push('c.merchant_id=?');args.push(user.merchant_id);}if(user.role!=='MERCHANT'&&!has(user,'claims.manage')&&!has(user,'claims.read')){where.push('c.created_by=?');args.push(user.id);}if(agencyScoped(user)){where.push("s.agency_id=? AND c.category<>'PAYMENT'");args.push(user.agency_id||'NO_AGENCY');}
   return send(res,200,{claims:all(`SELECT c.*,s.tracking,m.name AS merchant_name,u.full_name AS assignee FROM claims c LEFT JOIN shipments s ON s.id=c.shipment_id AND s.company_id=c.company_id LEFT JOIN merchants m ON m.id=c.merchant_id LEFT JOIN users u ON u.id=c.assigned_to WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC LIMIT 300`,...args)});
  }
  if(method==='POST'){
   requirePermission(user,'claims.create','claims.manage');const data=await json(ctx.req),subject=clean(data.subject,160),message=clean(data.message,4000),category=data.category||'OTHER',priority=data.priority||'NORMAL';
   if(subject.length<4||message.length<5||!categories.includes(category)||!['NORMAL','HIGH','URGENT'].includes(priority))throw fail(400,'Sujet, description, catégorie et priorité requis');
   const s=data.shipmentId?shipment(ctx,data.shipmentId):null,p=data.pickupId?pickupAccess(ctx,stmt('SELECT * FROM pickups WHERE id=? AND company_id=?',data.pickupId,companyId)):null;
   let mid=user.role==='MERCHANT'?user.merchant_id:s?.merchant_id||p?.merchant_id||null;
   if(data.merchantId){if(mid&&mid!==data.merchantId)throw fail(403,'Marchand incohérent');mid=merchantId(ctx,data.merchantId);}
   if(s&&p&&s.merchant_id!==p.merchant_id)throw fail(400,'Colis et ramassage de marchands différents');if(['DRIVER','PICKUP_DRIVER'].includes(user.role)&&!s&&!p)throw fail(400,'Liez l’incident à un colis ou à votre ramassage');if(agencyScoped(user)&&(!s||category==='PAYMENT'))throw fail(403,'Réclamation agence non autorisée');
   const claimId=id(),ref=reference('REC'),hours=stmt('SELECT claim_sla_hours FROM operation_settings WHERE company_id=?',companyId)?.claim_sla_hours??24,due=new Date(Date.now()+hours*3600000).toISOString();
   tx(()=>{run("INSERT INTO claims(id,company_id,merchant_id,shipment_id,pickup_id,reference,category,subject,priority,state,created_by,created_at,updated_at,due_at) VALUES(?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?)",claimId,companyId,mid,s?.id||null,p?.id||null,ref,category,subject,priority,user.id,now(),now(),due);run('INSERT INTO claim_messages VALUES(?,?,?,?,?,?,?)',id(),companyId,claimId,user.id,message,0,now());audit(companyId,user.id,'CLAIM_OPENED','claim',claimId,{category,priority});notify(ctx,{roles:['ADMIN','OPERATIONS','SUPPORT']},'Nouvelle réclamation '+ref,'claim',claimId);});return send(res,201,{id:claimId,reference:ref,state:'OPEN'});
  }
 }
 const match=path.match(/^\/api\/workflow\/claims\/([a-f0-9-]{36})(?:\/(messages|update|attachments)(?:\/([a-f0-9-]{36}))?)?$/);if(!match)return false;
 const claimId=match[1],action=match[2],t=ticketAccess(ctx,stmt('SELECT * FROM claims WHERE id=? AND company_id=?',claimId,companyId));
 if(method==='GET'&&!action)return send(res,200,detail(ctx,t));
 if(method==='GET'&&action==='attachments'&&match[3]){
  const attachment=stmt('SELECT a.*,COALESCE(m.internal,0) AS internal FROM claim_attachments a LEFT JOIN claim_messages m ON m.id=a.message_id AND m.company_id=a.company_id WHERE a.id=? AND a.claim_id=? AND a.company_id=?',match[3],claimId,companyId);if(!attachment)throw fail(404,'Pièce introuvable');if(attachment.internal&&!has(user,'claims.manage')&&!has(user,'claims.read'))throw fail(403,'Pièce interne');
  res.writeHead(200,{'Content-Type':attachment.mime,'Content-Disposition':`attachment; filename="piece-${attachment.id}.${attachment.mime==='application/pdf'?'pdf':attachment.mime==='image/png'?'png':'jpg'}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(Buffer.from(attachment.data));
 }
 if(method!=='POST')throw fail(405,'Méthode non autorisée');const data=await json(ctx.req);
 if(action==='messages'){
  requirePermission(user,'claims.create','claims.manage','claims.reply');if(t.state==='CLOSED')throw fail(409,'Rouvrez le ticket avant de répondre');const message=clean(data.message,4000),internal=data.internal===true;if(message.length<2)throw fail(400,'Message requis');if(internal)requirePermission(user,'claims.manage');
  tx(()=>{run('INSERT INTO claim_messages VALUES(?,?,?,?,?,?,?)',id(),companyId,claimId,user.id,message,internal?1:0,now());if(!internal){const state=['OPEN','WAITING_MERCHANT','WAITING_AGENCY','RESOLVED'].includes(t.state)?'IN_PROGRESS':t.state;run('UPDATE claims SET state=?,updated_at=? WHERE id=? AND company_id=?',state,now(),claimId,companyId);if(user.role==='MERCHANT')notify(ctx,{roles:['ADMIN','OPERATIONS','SUPPORT']},'Réponse marchand '+t.reference,'claim',claimId);else notify(ctx,{merchant:t.merchant_id},'Réponse à votre réclamation '+t.reference,'claim',claimId);}audit(companyId,user.id,'CLAIM_MESSAGE','claim',claimId,{internal});});
 }else if(action==='update'){
  const next=data.state,states=['IN_PROGRESS','WAITING_MERCHANT','WAITING_AGENCY','RESOLVED','CLOSED'];if(!states.includes(next))throw fail(400,'État de réclamation invalide');
  if(['MERCHANT','DRIVER','PICKUP_DRIVER'].includes(user.role)){if(!(next==='IN_PROGRESS'&&['RESOLVED','CLOSED'].includes(t.state)||next==='CLOSED'&&t.state==='RESOLVED'))throw fail(403,'Vous pouvez seulement rouvrir ou confirmer la clôture de votre ticket');if(clean(data.note).length<5)throw fail(400,'Motif requis');}else requirePermission(user,'claims.manage');
  if(next==='RESOLVED'&&clean(data.note).length<5)throw fail(400,'Solution motivée requise');if(next==='CLOSED'&&!['RESOLVED','CLOSED'].includes(t.state))throw fail(409,'Résolvez le ticket avant clôture');
  let assignee=t.assigned_to;if(data.assignedTo!==undefined){requirePermission(user,'claims.manage');assignee=data.assignedTo||null;if(assignee&&!stmt("SELECT 1 FROM users WHERE id=? AND company_id=? AND role IN ('ADMIN','OPERATIONS','SUPPORT') AND active=1",assignee,companyId))throw fail(400,'Agent support invalide');}
  tx(()=>{run('UPDATE claims SET state=?,assigned_to=?,resolution=CASE WHEN ?=\'RESOLVED\' THEN ? ELSE resolution END,updated_at=? WHERE id=? AND company_id=?',next,assignee,next,clean(data.note,4000),now(),claimId,companyId);if(clean(data.note))run('INSERT INTO claim_messages VALUES(?,?,?,?,?,?,?)',id(),companyId,claimId,user.id,clean(data.note,4000),0,now());audit(companyId,user.id,'CLAIM_UPDATED','claim',claimId,{from:t.state,to:next,assignedTo:assignee});notify(ctx,{merchant:t.merchant_id},'Réclamation '+t.reference+' : '+next,'claim',claimId);});
 }else if(action==='attachments'&&!match[3]){
  requirePermission(user,'claims.create','claims.manage','claims.reply');if(t.state==='CLOSED')throw fail(409,'Ticket clôturé');const filename=clean(data.filename,160),mime=data.mime,encoded=data.base64;if(!filename||typeof encoded!=='string'||encoded.length>1400000||!['image/png','image/jpeg','application/pdf'].includes(mime))throw fail(400,'Pièce PNG, JPEG ou PDF ; 1 Mo maximum');
  const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>1000000)throw fail(400,'Pièce trop volumineuse');const valid=mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.subarray(0,5).toString()==='%PDF-';if(!valid)throw fail(400,'Le contenu ne correspond pas au type de fichier');
  let messageId=data.messageId||null;if(messageId){const message=stmt('SELECT * FROM claim_messages WHERE id=? AND claim_id=? AND company_id=?',messageId,claimId,companyId);if(!message)throw fail(400,'Message inconnu');if(message.internal)requirePermission(user,'claims.manage');}
  tx(()=>{if(stmt('SELECT COUNT(*) AS n FROM claim_attachments WHERE claim_id=? AND company_id=?',claimId,companyId).n>=5)throw fail(409,'Maximum cinq pièces par ticket');run('INSERT INTO claim_attachments VALUES(?,?,?,?,?,?,?,?,?)',id(),companyId,claimId,messageId,filename,mime,bytes,user.id,now());audit(companyId,user.id,'CLAIM_ATTACHMENT','claim',claimId,{filename,mime,size:bytes.length});});
 }else throw fail(404,'Action de réclamation inconnue');
 return send(res,200,detail(ctx,stmt('SELECT * FROM claims WHERE id=? AND company_id=?',claimId,companyId)));
}
