export const STATUSES = ['CREATED','AWAITING_PICKUP','RETURNED_MERCHANT','COLLECTED','AT_AGENCY','UNREACHABLE','LOST','DAMAGED','ASSIGNED_AGENCY','EXPORTED','HANDED_OVER','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','POSTPONED','DELIVERED','REFUSED','RETURNING','RETURNED','CANCELLED'];
export const STATUS_LABELS = {
 AWAITING_PICKUP:'En attente de ramassage', RETURNED_MERCHANT:'Retourné au marchand', COLLECTED:'Collecté chez le marchand', AT_AGENCY:'Reçu par ville', UNREACHABLE:'Injoignable', LOST:'Perdu', DAMAGED:'Endommagé', CREATED:'À imprimer', ASSIGNED_AGENCY:'Affecté à l’agence', EXPORTED:'Exporté (historique)',
 HANDED_OVER:'Remis à l’agence', PICKED_UP:'Ramassé', IN_TRANSIT:'Envoi expédié',
 OUT_FOR_DELIVERY:'Mise en distribution', POSTPONED:'Reporté', DELIVERED:'Livré',
 REFUSED:'Refusé', RETURNING:'En retour', RETURNED:'Reçu par agence d’origine', CANCELLED:'Annulé'
};
const transitions = {
 AWAITING_PICKUP:['COLLECTED','PICKED_UP','CANCELLED'],
 RETURNED_MERCHANT:[],
 CREATED:['AWAITING_PICKUP','ASSIGNED_AGENCY','COLLECTED','PICKED_UP','CANCELLED'],
 COLLECTED:['PICKED_UP','RETURNING'],
 AT_AGENCY:['OUT_FOR_DELIVERY','POSTPONED','RETURNING'],
 UNREACHABLE:['OUT_FOR_DELIVERY','POSTPONED','RETURNING'],
 DAMAGED:['RETURNING'],LOST:[],
 ASSIGNED_AGENCY:['EXPORTED','HANDED_OVER','PICKED_UP','CANCELLED'],
 EXPORTED:['HANDED_OVER','PICKED_UP','CANCELLED'],
 HANDED_OVER:['PICKED_UP','IN_TRANSIT','RETURNING'],
 PICKED_UP:['AT_AGENCY','IN_TRANSIT','OUT_FOR_DELIVERY','RETURNING'],
 IN_TRANSIT:['AT_AGENCY','OUT_FOR_DELIVERY','UNREACHABLE','POSTPONED','RETURNING'],
 OUT_FOR_DELIVERY:['DELIVERED','REFUSED','UNREACHABLE','POSTPONED','RETURNING'],
 POSTPONED:['OUT_FOR_DELIVERY','REFUSED','RETURNING'],
 REFUSED:['RETURNING'], RETURNING:['RETURNED'],
 DELIVERED:[],RETURNED:[],CANCELLED:[]
};
export function canTransition(from,to){return from===to || (to==='CANCELLED'&&['COLLECTED','PICKED_UP','IN_TRANSIT','AT_AGENCY','OUT_FOR_DELIVERY','POSTPONED','UNREACHABLE','REFUSED'].includes(from)) || (transitions[from]||[]).includes(to);}
// External systems frequently omit intermediate milestones. Accept forward jumps
// while rejecting impossible terminal reversals and stale backwards updates.
export function canAgencyTransition(from,to){
 if(from===to)return true;
 if(['DELIVERED','RETURNED','RETURNED_MERCHANT','CANCELLED','LOST','DAMAGED'].includes(from))return false;
 if(to==='DELIVERED')return !['REFUSED','RETURNING'].includes(from);
 if(to==='REFUSED')return ['ASSIGNED_AGENCY','EXPORTED','HANDED_OVER','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','AT_AGENCY','UNREACHABLE','POSTPONED'].includes(from);
 if(to==='RETURNING')return ['HANDED_OVER','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','AT_AGENCY','UNREACHABLE','POSTPONED','REFUSED'].includes(from);
 if(to==='RETURNED')return ['REFUSED','RETURNING'].includes(from);
 if(to==='UNREACHABLE')return ['IN_TRANSIT','AT_AGENCY','OUT_FOR_DELIVERY','POSTPONED'].includes(from);
 if(to==='POSTPONED')return ['PICKED_UP','IN_TRANSIT','AT_AGENCY','OUT_FOR_DELIVERY','UNREACHABLE'].includes(from);
 if(['POSTPONED','UNREACHABLE'].includes(from)&&to==='OUT_FOR_DELIVERY')return true;
 const steps=['ASSIGNED_AGENCY','EXPORTED','HANDED_OVER','PICKED_UP','IN_TRANSIT','AT_AGENCY','OUT_FOR_DELIVERY'];
 const a=steps.indexOf(from),b=steps.indexOf(to);
 return a>=0&&b>=0&&b>a;
}
export function mapAgencyStatus(raw,custom={}){
 const normalized=String(raw||'').trim().toUpperCase().replace(/[\s-]+/g,'_');
 const mappings={ATTEND_DE_RAMASSAGE:'AWAITING_PICKUP',EN_ATTENTE_DE_RAMASSAGE:'AWAITING_PICKUP',
  RAMASSE:'PICKED_UP',RAMASSÉ:'PICKED_UP',PICKED:'PICKED_UP',EN_COURS:'IN_TRANSIT',
  EXPEDIE:'IN_TRANSIT',EXPÉDIÉ:'IN_TRANSIT',RECU_PAR_VILLE:'AT_AGENCY',REÇU_PAR_VILLE:'AT_AGENCY',MISE_EN_DISTRIBUTION:'OUT_FOR_DELIVERY',SORTIE_POUR_LA_LIVRAISON:'OUT_FOR_DELIVERY',RECU_AGENCE:'AT_AGENCY',INJOIGNABLE:'UNREACHABLE',EN_LIVRAISON:'OUT_FOR_DELIVERY',LIVRE:'DELIVERED',LIVRÉ:'DELIVERED',
  REFUSE:'REFUSED',REFUSÉ:'REFUSED',RETOUR:'RETURNING',RETOURNE:'RETURNED',
  REPORTÉ:'POSTPONED',REPORTE:'POSTPONED'};
 const result=custom[normalized]||mappings[normalized]||normalized;
 return STATUSES.includes(result)?result:null;
}
export const centimes = value => {
 const num=Number(value); if(!Number.isFinite(num)||num<0||num>10000000)throw Object.assign(Error('Montant invalide'),{status:400});
 return Math.round(num*100);
};
export function validTracking(x){return /^[A-Za-z0-9_-]{4,64}$/.test(String(x||''));}
export const cityKey=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').trim().toLowerCase().replace(/\s+/g,' ');
