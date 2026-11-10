import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { lock, one, transaction, type Database, type Transaction } from './db.js';
import { activeAgency, filterWindow, scanInput, type Order } from './domain.js';
import { bonPdf, pdfMime, readWorkbook, xlsxMime } from './documents.js';
import { ApiError, code, conflict, forbidden, missing, page, param, sendFile, text, uuid } from './http.js';
import { canEditReturnBonMembership, type Principal } from './security/authorization.js';
import { digest } from './security/crypto.js';
import { audit, check, ownScope, type Context } from './security/session.js';
import { restockReturn, stockLock } from './stock.js';

interface Bon {
  id:string;
  agency_id:string;
  agency:string;
  creator_kind:'AGENCY'|'STAFF';
  status:'BROUILLON'|'ENVOYE'|'RECU';
  first_received_at:Date|null;
  received_at:Date|null;
  deleted_at:Date|null;
  created_at:Date;
}
const bonFields='b.id,b.agency_id,a.name AS agency,b.creator_kind,b.status,b.first_received_at,b.received_at,b.deleted_at,b.created_at';
const required="l.anomaly_reason IS NULL AND (l.required OR v2_return_eligible(o.status,o.return_authorized,o.is_exchange))";
const filter=z.object({...filterWindow,agencyId:uuid.optional(),status:z.enum(['BROUILLON','ENVOYE','RECU']).optional(),page});
const damagePhoto=z.object({
  mime:z.enum(['image/jpeg','image/png','image/webp']),
  base64:z.string().min(4).max(2_800_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

export async function savePrivatePhoto(db: Transaction,user: Principal, photo:z.infer<typeof damagePhoto>) {
  const data=Buffer.from(photo.base64,'base64');
  const valid=data.length<=2_000_000 && (photo.mime==='image/jpeg' && data.subarray(0,3).equals(Buffer.from([255,216,255]))
    || photo.mime==='image/png' && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || photo.mime==='image/webp' && data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP');
  if (!valid) throw new ApiError(422,'FILE_INVALID','Choisissez une image JPEG, PNG ou WebP valide.');
  return (await one<{id:string}>(db,'INSERT INTO v2_private_files(mime,data,owner_id) VALUES($1,$2,$3) RETURNING id',[photo.mime,data,user.id]))!.id;
}

async function getBon(db: Database,user: Principal,id: string,locked=false) {
  const bon=await one<Bon>(db,`SELECT ${bonFields} FROM v2_return_bons b JOIN v2_agencies a ON a.id=b.agency_id
    WHERE b.id=$1 AND b.deleted_at IS NULL AND ($2::uuid IS NULL OR b.agency_id=$2)${locked?' FOR UPDATE OF b':''}`,[id,user.agencyId??null]);
  if (!bon) throw missing('Bon Retour Agence introuvable.');
  return bon;
}

function mayEdit(user: Principal,bon: Bon) {
  const decision=canEditReturnBonMembership(user,{
    agencyId:bon.agency_id,creatorKind:bon.creator_kind,firstReceivedAt:bon.first_received_at,deletedAt:bon.deleted_at,status:bon.status,
  });
  if (!decision.allowed) {
    if (decision.reason==='BON_LOCKED') throw conflict('BON_LOCKED','La liste est verrouillée depuis le premier scan.');
    throw forbidden();
  }
}

async function addLines(db: Transaction,user: Principal,bonId: string,agencyId: string,codes: string[]) {
  await db.query(`INSERT INTO v2_return_bon_lines(bon_id,tracking_code,order_id,anomaly_reason,required)
    SELECT $1,t.code,o.id,
      CASE WHEN t.code !~ '^[A-Z0-9][A-Z0-9-]{2,63}$' THEN 'FORMAT_INVALIDE' WHEN o.id IS NULL THEN 'CODE_INCONNU' WHEN o.agency_id IS DISTINCT FROM $2 THEN 'HORS_AGENCE' END,
      COALESCE(o.agency_id=$2 AND v2_return_eligible(o.status,o.return_authorized,o.is_exchange),false)
    FROM unnest($3::text[]) AS t(code) LEFT JOIN v2_orders o ON o.tracking_code=t.code AND t.code ~ '^[A-Z0-9][A-Z0-9-]{2,63}$' AND (NOT $4 OR o.agency_id=$2)
    ON CONFLICT(bon_id,tracking_code) DO NOTHING`,[bonId,agencyId,codes,Boolean(user.agencyId)]);
}

async function detail(db: Database,user: Principal,bon: Bon) {
  const lines=(await db.query(`SELECT l.id,l.tracking_code,l.anomaly_reason,l.received_at,l.input_method,l.superseded_at,l.superseded_by,
      l.damaged,l.damage_note,l.damage_photo_id,
      CASE WHEN $2 THEN NULL ELSE l.order_id END AS order_id,
      CASE WHEN l.anomaly_reason IS NULL THEN o.status END AS order_status,
      COALESCE(v2_return_eligible(o.status,o.return_authorized,o.is_exchange),false) AS status_valid,
      COALESCE(${required},false) AS required,o.is_exchange
    FROM v2_return_bon_lines l LEFT JOIN v2_orders o ON o.id=l.order_id WHERE l.bon_id=$1 ORDER BY l.tracking_code`,
    [bon.id,Boolean(user.agencyId)])).rows;
  return {
    bon,lines,canEdit:canEditReturnBonMembership(user,{agencyId:bon.agency_id,creatorKind:bon.creator_kind,
      firstReceivedAt:bon.first_received_at,deletedAt:bon.deleted_at,status:bon.status}).allowed,
    counts:{
      received:lines.filter(row=>row.received_at).length,
      expected:lines.filter(row=>row.required&&!row.received_at&&!row.superseded_at).length,
      missing:lines.filter(row=>row.required&&!row.received_at&&!row.superseded_at).length,
      anomalies:lines.filter(row=>row.anomaly_reason).length,
      invalid:lines.filter(row=>!row.anomaly_reason&&!row.status_valid&&!row.received_at&&!row.superseded_at).length,
      reconciled:lines.filter(row=>row.superseded_at).length,
      manual:lines.filter(row=>row.input_method==='MANUAL').length,
    },
  };
}

export function agencyReturnRoutes(ctx: Context) {
  const { app,pool }=ctx;
  app.get('/api/v2/return-bons',async request=>{
    const user=await ctx.user(request); check(user,'returns.read',ownScope(user));
    const query=filter.parse(request.query);
    if (user.agencyId && query.agencyId && user.agencyId!==query.agencyId) throw forbidden();
    const {rows}=await pool.query(`SELECT ${bonFields}, COUNT(*) OVER()::int AS total,
      (SELECT COUNT(*)::int FROM v2_return_bon_lines l WHERE l.bon_id=b.id AND l.received_at IS NOT NULL) AS received,
      (SELECT COUNT(*)::int FROM v2_return_bon_lines l LEFT JOIN v2_orders o ON o.id=l.order_id
        WHERE l.bon_id=b.id AND l.received_at IS NULL AND l.superseded_at IS NULL AND ${required}) AS expected
      FROM v2_return_bons b JOIN v2_agencies a ON a.id=b.agency_id
      WHERE b.deleted_at IS NULL AND ($1::uuid IS NULL OR b.agency_id=$1) AND ($2::text IS NULL OR b.status=$2)
      AND ($3::timestamptz IS NULL OR b.created_at>=$3) AND ($4::timestamptz IS NULL OR b.created_at<$4)
      AND ($5::text IS NULL OR strpos(b.id::text,lower($5))>0 OR EXISTS(
        SELECT FROM v2_return_bon_lines l WHERE l.bon_id=b.id AND strpos(l.tracking_code,upper($5))>0))
      ORDER BY b.created_at DESC,b.id DESC LIMIT 50 OFFSET $6`,
      [user.agencyId??query.agencyId??null,query.status??null,query.from??null,query.to??null,query.search??null,(query.page-1)*50]);
    return { rows,total:rows[0]?.total??0,page:query.page };
  });
  app.get('/api/v2/return-bons/:id',async request=>{
    const user=await ctx.user(request); check(user,'returns.read',ownScope(user));
    return detail(pool,user,await getBon(pool,user,param(request)));
  });

  async function create(user: Principal,agencyId:string,codes:string[],fingerprint?:string) {
    check(user,'returns.manage',{ agencyId });
    await activeAgency(pool,agencyId);
    return transaction(pool,async db=>{
      await lock(db,'return',agencyId);
      if (fingerprint) {
        const previous=await one<{id:string}>(db,`SELECT id FROM v2_return_bons
          WHERE agency_id=$1 AND import_fingerprint=$2 AND deleted_at IS NULL`,[agencyId,fingerprint]);
        if (previous) throw new ApiError(409,'DUPLICATE_IMPORT','Ce fichier a déjà créé un bon actif.',{ bonId:previous.id });
      }
      const row=await one<{id:string}>(db,`INSERT INTO v2_return_bons(agency_id,created_by,creator_kind,import_fingerprint)
        VALUES($1,$2,$3,$4) RETURNING id`,[agencyId,user.id,user.agencyId?'AGENCY':'STAFF',fingerprint??null]);
      await addLines(db,user,row!.id,agencyId,codes);
      await audit(db,user,'RETURN_BON_CREATED','RETURN_BON',row!.id,{ count:codes.length,imported:Boolean(fingerprint) });
      return detail(db,user,await getBon(db,user,row!.id));
    });
  }
  app.post('/api/v2/return-bons',async (request,reply)=>{
    const user=await ctx.user(request);
    const input=z.object({ agencyId:uuid,codes:z.array(code).max(5000) }).strict().parse(request.body);
    return reply.code(201).send(await create(user,input.agencyId,[...new Set(input.codes)]));
  });
  app.post('/api/v2/agencies/:id/return-import', { config:{ rateLimit:{ max:15,timeWindow:'1 minute' } } },async (request,reply)=>{
    const user=await ctx.user(request),agencyId=param(request);
    check(user,'returns.manage',{ agencyId });
    const agency=await activeAgency(pool,agencyId);
    const file=await request.file({ limits:{ fileSize:3_000_000,files:1,parts:1 } });
    if (!file || !file.filename.toLowerCase().endsWith('.xlsx') || file.mimetype!==xlsxMime) {
      throw new ApiError(422,'XLSX_REQUIRED','Choisissez un fichier .xlsx.');
    }
    const rows=await readWorkbook(await file.toBuffer());
    const normalize=(value:string)=>value.normalize('NFC').trim().replace(/\s+/g,' ').toUpperCase();
    const headers=rows[0]?.map(normalize)??[];
    const column=headers.indexOf(normalize(agency.return_excel_header));
    if (column<0 || headers.lastIndexOf(normalize(agency.return_excel_header))!==column) {
      throw new ApiError(422,'XLSX_HEADER','Le fichier doit contenir une seule colonne « '+agency.return_excel_header+' ».');
    }
    const codes=[...new Set(rows.slice(1).map(row=>normalize(row[column]??'')).filter(Boolean).map(value=>value.slice(0,250)))];
    if (!codes.length) throw new ApiError(422,'XLSX_EMPTY','Aucun code dans ce fichier.');
    const fingerprint=digest(JSON.stringify([headers,...rows.slice(1).map(row=>JSON.stringify(row.map(normalize))).sort()]));
    return reply.code(201).send(await create(user,agencyId,codes,fingerprint));
  });

  app.post('/api/v2/return-bons/:id/lines',async request=>{
    const user=await ctx.user(request); check(user,'returns.manage',ownScope(user));
    const id=param(request);
    const input=z.object({ add:z.array(code).max(5000).default([]),remove:z.array(text(250)).max(5000).default([]),confirmed:z.literal(true).optional() }).strict()
      .refine(row=>row.remove.length===0||row.confirmed===true).parse(request.body);
    return transaction(pool,async db=>{
      const initial=await getBon(db,user,id);
      await lock(db,'return',initial.agency_id);
      const bon=await getBon(db,user,id,true);
      mayEdit(user,bon);
      const removed=(await db.query<{tracking_code:string}>('DELETE FROM v2_return_bon_lines WHERE bon_id=$1 AND tracking_code=ANY($2::text[]) RETURNING tracking_code',[id,input.remove])).rows;
      await addLines(db,user,id,bon.agency_id,[...new Set(input.add)]);
      for (const row of removed) await audit(db,user,'RETURN_CODE_REMOVED','RETURN_BON',id,{ code:row.tracking_code });
      await audit(db,user,'RETURN_BON_EDITED','RETURN_BON',id,{ add:input.add.length,remove:removed.length });
      return detail(db,user,bon);
    });
  });
  app.delete('/api/v2/return-bons/:id',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'returns.manage',ownScope(user));
    const id=param(request);
    z.object({ confirmed:z.literal(true) }).strict().parse(request.body);
    await transaction(pool,async db=>{
      const initial=await getBon(db,user,id);
      await lock(db,'return',initial.agency_id);
      mayEdit(user,await getBon(db,user,id,true));
      await db.query('UPDATE v2_return_bons SET deleted_at=now() WHERE id=$1',[id]);
      await audit(db,user,'RETURN_BON_DELETED','RETURN_BON',id);
    });
    return reply.code(204).send();
  });
  app.post('/api/v2/return-bons/:id/state',async request=>{
    const user=await ctx.user(request);
    const id=param(request);
    const input=z.object({ action:z.enum(['SEND','REOPEN','CLOSE']),confirmed:z.literal(true).optional(),receivedCount:z.number().int().min(0).optional() }).strict().parse(request.body);
    return transaction(pool,async db=>{
      const initial=await getBon(db,user,id);
      check(user,input.action==='CLOSE'?'returns.scan':'returns.manage',{agencyId:initial.agency_id});
      if (user.agencyId && initial.creator_kind!=='AGENCY') throw forbidden();
      await lock(db,'return',initial.agency_id);
      const bon=await getBon(db,user,id,true);
      if (input.action==='SEND' && bon.status==='BROUILLON') {
        if (!await one(db,'SELECT 1 FROM v2_return_bon_lines WHERE bon_id=$1 LIMIT 1',[id])) throw conflict('BON_EMPTY','Ajoutez des colis avant l’envoi.');
        await db.query("UPDATE v2_return_bons SET status='ENVOYE' WHERE id=$1",[id]);
      } else if (input.action==='REOPEN' && bon.status==='ENVOYE') {
        await db.query("UPDATE v2_return_bons SET status='BROUILLON' WHERE id=$1",[id]);
      } else if (input.action==='CLOSE' && bon.status==='ENVOYE') {
        await db.query('SELECT o.id FROM v2_return_bon_lines l JOIN v2_orders o ON o.id=l.order_id WHERE l.bon_id=$1 ORDER BY o.id FOR UPDATE OF o',[id]);
        const data=await detail(db,user,bon);
        if (!input.confirmed || input.receivedCount!==data.counts.received) throw conflict('CONFIRM_COUNTS','Actualisez et confirmez le nombre de colis reçus.');
        await db.query("UPDATE v2_return_bons SET status='RECU',received_at=clock_timestamp(),received_by=$2 WHERE id=$1",[id,user.id]);
      } else throw conflict('BON_STATUS','Action indisponible dans cet état.');
      await audit(db,user,'RETURN_BON_'+input.action,'RETURN_BON',id,{ receivedCount:input.receivedCount });
      return detail(db,user,await getBon(db,user,id));
    });
  });
  app.post('/api/v2/return-bons/:id/receive', { bodyLimit:3_000_000 },async request=>{
    const user=await ctx.user(request); check(user,'returns.scan');
    const id=param(request);
    const input=scanInput.extend({ damaged:z.boolean().default(false),note:text(400).optional(),photo:damagePhoto.optional() })
      .refine(row=>row.damaged||!row.note&&!row.photo).parse(request.body);
    return transaction(pool,async db=>{
      const bon=await getBon(db,user,id);
      await lock(db,'return',bon.agency_id);
      const initial=await one<Order>(db,'SELECT * FROM v2_orders WHERE tracking_code=$1',[input.trackingCode]);
      if (!initial) throw new ApiError(404,'SCAN_UNKNOWN','Code de suivi inconnu.');
      if (!await one(db,'SELECT 1 FROM v2_return_bon_lines WHERE bon_id=$1 AND tracking_code=$2',[id,input.trackingCode])) {
        const removed=await one(db,`SELECT 1 FROM v2_audit_events WHERE entity_type='RETURN_BON' AND entity_id=$1
          AND action='RETURN_CODE_REMOVED' AND metadata->>'code'=$2`,[id,input.trackingCode]);
        throw conflict(removed?'RETURN_CODE_REMOVED':'RETURN_CODE_NOT_INCLUDED',
          removed?'Code retiré du Bon — Veuillez actualiser.':'Ce code ne figure pas dans ce bon.');
      }
      if (initial.source==='STOCK') await stockLock(db,initial.merchant_id);
      const order=(await one<Order>(db,'SELECT * FROM v2_orders WHERE id=$1 FOR UPDATE',[initial.id]))!;
      const priorPhoto=input.photo && await one<{damage_photo_id:string;data:Buffer;mime:string}>(db,`SELECT l.damage_photo_id,f.data,f.mime
        FROM v2_return_bon_lines l JOIN v2_private_files f ON f.id=l.damage_photo_id JOIN v2_scan_events e ON e.bon_id=l.bon_id AND e.order_id=l.order_id
        WHERE l.bon_id=$1 AND l.tracking_code=$2 AND e.request_key=$3`,[id,input.trackingCode,input.requestKey]);
      const photoId=input.photo
        ? priorPhoto && priorPhoto.mime===input.photo.mime && priorPhoto.data.equals(Buffer.from(input.photo.base64,'base64'))
          ? priorPhoto.damage_photo_id : await savePrivatePhoto(db,user,input.photo)
        : null;
      let receipt;
      try {
        receipt=await one<{outcome:string;line_id:string;order_id:string}>(db,
          'SELECT * FROM v2_receive_return($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [id,input.trackingCode,user.id,input.method,input.requestKey,input.confirmed??false,input.damaged,input.note??null,photoId]);
      } catch (error) {
        const fault=error as Error;
        if (fault.message==='SCAN_WRONG_STATUS') throw new ApiError(409,'SCAN_WRONG_STATUS','Corrigez le statut avant réception.',{ orderId:order.id });
        if (fault.message==='SCAN_WRONG_AGENCY') {
          throw new ApiError(409,'SCAN_WRONG_AGENCY','Le colis ne se trouve pas dans cette agence.',
            { agencyId:order.current_holder_type==='AGENCY'?order.current_holder_id:order.agency_id });
        }
        throw error;
      }
      if (receipt!.outcome==='RECEIVED') {
        if (order.source==='STOCK' && !(order.status==='LIVRE' && order.is_exchange)) {
          await restockReturn(db,order,input.damaged,user);
        } else {
          await db.query(`INSERT INTO v2_merchant_return_queue(order_id,merchant_id,agency_line_id,received_at,is_exchange,damaged)
            SELECT $1,$2,id,received_at,$4,$5 FROM v2_return_bon_lines WHERE id=$3`,
            [order.id,order.merchant_id,receipt!.line_id,order.is_exchange,input.damaged]);
        }
      }
      return { outcome:receipt!.outcome,code:input.trackingCode };
    });
  });
  app.get('/api/v2/return-bons/:id/pdf',async (request,reply)=>{
    const user=await ctx.user(request); check(user,'returns.read',ownScope(user));
    const bon=await getBon(pool,user,param(request));
    if (bon.status!=='RECU') throw conflict('BON_NOT_CLOSED','Le PDF est disponible après la clôture du bon.');
    const {lines}=await detail(pool,user,bon);
    const pdf=await bonPdf({ title:'Bon de retour agence',id:bon.id,name:bon.agency,date:bon.received_at!,rows:lines.filter(row=>row.received_at) as Parameters<typeof bonPdf>[0]['rows'] });
    return sendFile(reply,'retour-agence-'+bon.id+'.pdf',pdfMime,pdf);
  });
  app.get('/api/v2/return-photos/:id',async (request,reply)=>{
    const user=await ctx.user(request);
    if (user.merchantId) check(user,'merchant_returns.read',ownScope(user));
    else check(user,'returns.read',ownScope(user));
    const photo=await one<{data:Buffer;mime:string}>(pool,`SELECT f.data,f.mime FROM v2_private_files f
      JOIN v2_return_bon_lines l ON l.damage_photo_id=f.id JOIN v2_return_bons b ON b.id=l.bon_id
      JOIN v2_orders o ON o.id=l.order_id WHERE f.id=$1
      AND ($2::uuid IS NULL OR o.merchant_id=$2) AND ($3::uuid IS NULL OR b.agency_id=$3)`,[param(request),user.merchantId??null,user.agencyId??null]);
    if (!photo) throw missing();
    return sendFile(reply,'preuve-dommage.'+photo.mime.split('/')[1],photo.mime,photo.data);
  });
}
