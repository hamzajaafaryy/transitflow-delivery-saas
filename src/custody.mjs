import {now} from './db.mjs';
export const CUSTODY_LABELS={UNKNOWN:'Localisation à vérifier',MERCHANT:'Chez le marchand',WAREHOUSE:'Agence d’origine / warehouse',PICKUP_DRIVER:'Avec le ramasseur',OUTBOUND:'Envoi vers la ville',AGENCY:'À l’agence de destination',DRIVER:'Avec le livreur',RETURN_TRANSIT:'Retour vers l’agence d’origine',RECIPIENT:'Chez le destinataire'};
export function setCustody(ctx,shipment,type,{agencyId=null,scan=false}={}){
 const time=now();
 ctx.run(`UPDATE shipments SET custody_type=?,custody_agency_id=?,custody_updated_at=?,last_scanned_at=CASE WHEN ? THEN ? ELSE last_scanned_at END,last_scanned_by=CASE WHEN ? THEN ? ELSE last_scanned_by END WHERE id=? AND company_id=?`,type,agencyId,time,scan?1:0,time,scan?1:0,ctx.user.id,shipment.id,ctx.companyId);
}
