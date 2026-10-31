import {id,now} from './db.mjs';
import {has,requirePermission,agencyScoped} from './access.mjs';
import {clean,fail,reference,merchantId,notify} from './workflow-shared.mjs';
function holderScope(user,alias='r'){
 if(user.role==='DRIVER')return {clause:` AND ${alias}.holder_user_id=?`,args:[user.id]};
 if(agencyScoped(user))return {clause:` AND ${alias}.holder_agency_id=?`,args:[user.agency_id||'NO_AGENCY']};
 return {clause:'',args:[]};
}
export async function cashRoute(ctx){
 const {path,method,url,user,companyId,stmt,all,run,tx,json,send,res,audit}=ctx;
 if(path==='/api/workflow/cash'){
  requirePermission(user,'cash.self','cash.manage','cash.read','finance');const scope=holderScope(user);
  return send(res,200,{receipts:all(`SELECT r.*,s.tracking,s.city,m.name AS merchant_name,u.full_name AS holder_name,a.name AS agency_name FROM cod_receipts r JOIN shipments s ON s.id=r.shipment_id AND s.company_id=r.company_id LEFT JOIN merchants m ON m.id=s.merchant_id LEFT JOIN users u ON u.id=r.holder_user_id LEFT JOIN agencies a ON a.id=r.holder_agency_id WHERE r.company_id=?${scope.clause} ORDER BY r.created_at DESC LIMIT 500`,companyId,...scope.args),remittances:all(`SELECT r.*,u.full_name AS holder_name,a.name AS agency_name FROM cash_remittances r LEFT JOIN users u ON u.id=r.holder_user_id LEFT JOIN agencies a ON a.id=r.holder_agency_id WHERE r.company_id=?${scope.clause} ORDER BY r.created_at DESC LIMIT 200`,companyId,...scope.args)});
 }
 if(path==='/api/workflow/cash/remittances'&&method==='POST'){
  requirePermission(user,'cash.self','cash.manage','finance');const data=await json(ctx.req),ids=data.receiptIds,proof=clean(data.proofReference,120);
  if(!Array.isArray(ids)||!ids.length||ids.length>1000||new Set(ids).size!==ids.length||proof.length<5)throw fail(400,'Sélection de fonds et référence de remise requises');
  const remittanceId=id(),ref=reference('CAISSE');let total=0,fees=0,expected=0;
  tx(()=>{const receipts=ids.map(sid=>stmt('SELECT * FROM cod_receipts WHERE id=? AND company_id=?',sid,companyId));if(receipts.some(r=>!r||r.state!=='DECLARED'))throw fail(409,'Fonds déjà remis ou non disponibles');
   const owner=receipts[0];if(receipts.some(r=>r.holder_user_id!==owner.holder_user_id||r.holder_agency_id!==owner.holder_agency_id))throw fail(400,'Une remise doit concerner un seul détenteur de fonds');
   if(user.role==='DRIVER'&&owner.holder_user_id!==user.id)throw fail(403,'Fonds d’un autre livreur');if(agencyScoped(user)&&owner.holder_agency_id!==user.agency_id)throw fail(403,'Fonds d’une autre agence');
   total=receipts.reduce((n,r)=>n+r.amount_centimes,0);fees=receipts.reduce((n,r)=>n+r.agency_fee_centimes,0);expected=total-fees;run("INSERT INTO cash_remittances(id,company_id,reference,holder_user_id,holder_agency_id,declared_centimes,state,proof_reference,note,created_by,created_at) VALUES(?,?,?,?,?,?,'SUBMITTED',?,?,?,?)",remittanceId,companyId,ref,owner.holder_user_id,owner.holder_agency_id,total,proof,clean(data.note,400),user.id,now());run('UPDATE cash_remittances SET fee_centimes=?,expected_centimes=? WHERE id=? AND company_id=?',fees,expected,remittanceId,companyId);for(const r of receipts){run('INSERT INTO cash_remittance_items VALUES(?,?,?)',companyId,remittanceId,r.id);run("UPDATE cod_receipts SET state='SUBMITTED' WHERE id=? AND company_id=?",r.id,companyId);}audit(companyId,user.id,'CASH_REMITTANCE_SUBMITTED','cash_remittance',remittanceId,{amountCentimes:total,count:ids.length});notify(ctx,{roles:['ADMIN','FINANCE']},'Remise de fonds à rapprocher '+ref,'cash',remittanceId);
  });return send(res,201,{id:remittanceId,reference:ref,declaredCentimes:total,feeCentimes:fees,expectedCentimes:expected,state:'SUBMITTED'});
 }
 const reconcile=path.match(/^\/api\/workflow\/cash\/remittances\/([a-f0-9-]{36})\/reconcile$/);
 if(reconcile&&method==='POST'){
  requirePermission(user,'cash.manage','finance');const data=await json(ctx.req),r=stmt('SELECT * FROM cash_remittances WHERE id=? AND company_id=?',reconcile[1],companyId),received=Math.round(Number(data.receivedAmount)*100),note=clean(data.note,400);if(!r)throw fail(404,'Remise introuvable');if(r.state==='RECONCILED')throw fail(409,'Remise déjà rapprochée');if(!Number.isSafeInteger(received)||Math.abs(received)>1000000000)throw fail(400,'Montant réellement reçu requis');
  const exact=received===r.expected_centimes;if(!exact&&note.length<5)throw fail(400,'Motif de l’écart de caisse requis');
  tx(()=>{run('UPDATE cash_remittances SET received_centimes=?,state=?,note=?,reconciled_at=? WHERE id=? AND company_id=?',received,exact?'RECONCILED':'DISPUTED',note,exact?now():null,r.id,companyId);
   if(exact){const receipts=all('SELECT c.* FROM cash_remittance_items i JOIN cod_receipts c ON c.id=i.receipt_id AND c.company_id=i.company_id WHERE i.remittance_id=? AND i.company_id=?',r.id,companyId);for(const receipt of receipts){const existing=stmt("SELECT amount_centimes FROM ledger WHERE company_id=? AND shipment_id=? AND type='COD_COLLECTED'",companyId,receipt.shipment_id);if(existing&&existing.amount_centimes!==receipt.amount_centimes)throw fail(409,'Écriture COD incohérente');if(!existing&&receipt.amount_centimes>0)run('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)',id(),companyId,receipt.shipment_id,'COD_COLLECTED',receipt.amount_centimes,'Rapprochement '+r.reference,user.id,now());run("UPDATE cod_receipts SET state='RECONCILED',reconciled_at=? WHERE id=? AND company_id=?",now(),receipt.id,companyId);}}
   audit(companyId,user.id,'CASH_REMITTANCE_RECONCILED','cash_remittance',r.id,{declared:r.declared_centimes,fees:r.fee_centimes,expected:r.expected_centimes,received,exact,note});
  });return send(res,200,{id:r.id,state:exact?'RECONCILED':'DISPUTED',varianceCentimes:received-r.expected_centimes});
 }
 if(path==='/api/workflow/adjustments'){
  if(method==='GET'){if(user.role!=='MERCHANT')requirePermission(user,'finance');const mid=user.role==='MERCHANT'?user.merchant_id:url.searchParams.get('merchantId');return send(res,200,{adjustments:all('SELECT a.*,m.name AS merchant_name FROM merchant_adjustments a JOIN merchants m ON m.id=a.merchant_id WHERE a.company_id=?'+(mid?' AND a.merchant_id=?':'')+' ORDER BY a.created_at DESC LIMIT 300',...mid?[companyId,mid]:[companyId])});}
  if(method==='POST'){
   requirePermission(user,'finance');const data=await json(ctx.req),mid=merchantId(ctx,data.merchantId),amount=Math.round(Number(data.amount)*100),kind=data.kind,ref=clean(data.reference,120),note=clean(data.note,500);
   if(!Number.isSafeInteger(amount)||amount===0||Math.abs(amount)>1000000000||!['REFUND','COMPENSATION','FEE_CORRECTION'].includes(kind)||ref.length<5||note.length<5||kind==='REFUND'&&amount>0||kind==='COMPENSATION'&&amount<0)throw fail(400,'Ajustement signé, type, référence et motif requis ; remboursement négatif, indemnisation positive');
   if(data.returnId){const ret=stmt('SELECT * FROM parcel_returns WHERE id=? AND company_id=? AND merchant_id=?',data.returnId,companyId,mid);if(!ret||!['RECEIVED','INSPECTED','COMPLETED'].includes(ret.state)||kind==='REFUND'&&!ret.after_delivery)throw fail(409,'Retour reçu après livraison requis pour ce remboursement');}
   const adjustmentId=id();try{tx(()=>{run('INSERT INTO merchant_adjustments(id,company_id,merchant_id,return_id,amount_centimes,kind,reference,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',adjustmentId,companyId,mid,data.returnId||null,amount,kind,ref,note,user.id,now());audit(companyId,user.id,'MERCHANT_ADJUSTMENT','merchant_adjustment',adjustmentId,{merchantId:mid,amount,kind,reference:ref});notify(ctx,{merchant:mid},'Ajustement comptable '+ref,'adjustment',adjustmentId);});}catch(e){if(String(e).includes('UNIQUE'))throw fail(409,'Référence ou remboursement déjà enregistré');throw e;}return send(res,201,{id:adjustmentId,amountCentimes:amount});
  }
 }
 return false;
}
