import {id,now} from './db.mjs';
import {requirePermission,requireShipmentAccess,shipmentScope,agencyScoped} from './access.mjs';
import {clean,fail,html} from './workflow-shared.mjs';
import {ticketsHtml} from './ticket.mjs';
export async function labelsRoute(ctx){
 const {path,method,user,companyId,stmt,all,run,tx,json,req,res,send,audit}=ctx;
 requirePermission(user,'shipments.create','warehouse','dispatch','agency.receive','driver','pickups.self');
 if(path==='/api/labels'&&method==='GET'){
  const source=ctx.url.searchParams.get('source'),merchantId=user.role==='MERCHANT'?user.merchant_id:ctx.url.searchParams.get('merchantId'),query=clean(ctx.url.searchParams.get('q'),100);
  if(!['EXTERNAL','STOCK'].includes(source))throw fail(400,'Source de commande requise');
  const scope=shipmentScope(user,'s'),where=['s.company_id=?'+scope.clause,'s.order_source=?'],args=[companyId,...scope.args,source];
  if(merchantId){where.push('s.merchant_id=?');args.push(merchantId);}
  if(agencyScoped(user)){where.push('s.agency_id=?');args.push(user.agency_id||'NO_AGENCY');}
  if(user.role==='DRIVER'){where.push('s.driver_id=?');args.push(user.id);}
  if(query){where.push("(instr(lower(s.tracking),lower(?))>0 OR instr(lower(s.recipient),lower(?))>0)");args.push(query,query);}
  where.push("s.status IN ('CREATED','AWAITING_PICKUP','ASSIGNED_AGENCY','EXPORTED','COLLECTED','PICKED_UP')");
  const shipments=all(`SELECT s.*,m.name AS merchant_name FROM shipments s LEFT JOIN merchants m ON m.id=s.merchant_id AND m.company_id=s.company_id WHERE ${where.join(' AND ')} ORDER BY s.labels_printed_at IS NOT NULL,s.created_at LIMIT 1000`,...args);
  return send(res,200,{shipments,total:stmt(`SELECT COUNT(*) AS n FROM shipments s WHERE ${where.join(' AND ')}`,...args).n,source,limit:1000});
 }
 if(path==='/api/labels'&&method==='POST'){
  const data=await json(req),ids=data.shipmentIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(x=>typeof x!=='string')||new Set(ids).size!==ids.length)throw fail(400,'Sélectionnez de 1 à 1 000 colis différents');
  const result=tx(()=>{
   const rows=ids.map(sid=>requireShipmentAccess(ctx,stmt('SELECT * FROM shipments WHERE id=? AND company_id=?',sid,companyId))),first=rows[0];
   if(rows.some(s=>s.merchant_id!==first.merchant_id||s.order_source!==first.order_source))throw fail(409,'Un lot de tickets doit contenir une seule source et un seul marchand');
   if(data.source&&data.source!==first.order_source||data.merchantId&&data.merchantId!==first.merchant_id)throw fail(409,'Le lot ne correspond pas au marchand ou à la source sélectionnés');
   if(rows.some(s=>['CANCELLED','RETURNED','RETURNED_MERCHANT','LOST'].includes(s.status)))throw fail(409,'Un colis clôturé en retour, annulé ou perdu ne peut pas être réétiqueté pour livraison');
   const batchId=id(),time=now();
   run('INSERT INTO label_batches VALUES(?,?,?,?,?,?)',batchId,companyId,first.merchant_id,first.order_source,user.id,time);
   for(let position=0;position<rows.length;position++){
    const s=rows[position];run('INSERT INTO label_batch_items VALUES(?,?,?,?)',batchId,companyId,s.id,position);
    run('UPDATE shipments SET labels_printed_at=COALESCE(labels_printed_at,?) WHERE id=? AND company_id=?',time,s.id,companyId);
    if(['CREATED','ASSIGNED_AGENCY','EXPORTED'].includes(s.status)){
     run("UPDATE shipments SET status='AWAITING_PICKUP',updated_at=? WHERE id=? AND company_id=?",time,s.id,companyId);
     run("INSERT INTO shipment_events(id,company_id,shipment_id,status,source,note,actor_id,created_at) VALUES(?,?,?,'AWAITING_PICKUP','LABEL',?,?,?)",id(),companyId,s.id,'Ticket 100 × 100 mm préparé — lot '+batchId,user.id,time);
    }
   }
   audit(companyId,user.id,'LABEL_BATCH_PREPARED','label_batch',batchId,{source:first.order_source,merchantId:first.merchant_id,count:rows.length});
   return {id:batchId,count:rows.length,source:first.order_source,printUrl:'/api/labels/'+batchId+'/print'};
  });return send(res,201,result);
 }
 const match=path.match(/^\/api\/labels\/([a-f0-9-]{36})\/print$/);
 if(match&&method==='GET'){
  const batch=stmt('SELECT * FROM label_batches WHERE id=? AND company_id=?',match[1],companyId);if(!batch)throw fail(404,'Lot de tickets introuvable');
  if(user.role==='MERCHANT'&&batch.merchant_id!==user.merchant_id)throw fail(403,'Tickets d’un autre marchand');
  const rows=all(`SELECT s.*,m.name AS merchant_name,a.name AS agency_name FROM label_batch_items i JOIN shipments s ON s.id=i.shipment_id AND s.company_id=i.company_id LEFT JOIN merchants m ON m.id=s.merchant_id AND m.company_id=s.company_id LEFT JOIN agencies a ON a.id=s.agency_id AND a.company_id=s.company_id WHERE i.batch_id=? AND i.company_id=? ORDER BY i.position`,batch.id,companyId);
  rows.forEach(s=>requireShipmentAccess(ctx,s));
  return html(res,ticketsHtml({shipments:rows,company:stmt('SELECT name FROM company WHERE id=?',companyId),publicBase:ctx.publicBase}));
 }
 throw fail(404,'Route tickets introuvable');
}
