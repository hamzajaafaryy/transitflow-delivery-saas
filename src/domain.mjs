export const STATUSES = ['CREATED','ASSIGNED_PARTNER','EXPORTED','HANDED_OVER','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','POSTPONED','DELIVERED','REFUSED','RETURNING','RETURNED','CANCELLED'];
export const STATUS_LABELS = {
 CREATED:'Créé', ASSIGNED_PARTNER:'Affecté au partenaire', EXPORTED:'Exporté',
 HANDED_OVER:'Remis au partenaire', PICKED_UP:'Ramassé', IN_TRANSIT:'En transit',
 OUT_FOR_DELIVERY:'En livraison', POSTPONED:'Reporté', DELIVERED:'Livré',
 REFUSED:'Refusé', RETURNING:'En retour', RETURNED:'Retourné', CANCELLED:'Annulé'
};
const transitions = {
 CREATED:['ASSIGNED_PARTNER','IN_TRANSIT','CANCELLED'],
 ASSIGNED_PARTNER:['EXPORTED','HANDED_OVER','PICKED_UP','CANCELLED'],
 EXPORTED:['HANDED_OVER','PICKED_UP','CANCELLED'],
 HANDED_OVER:['PICKED_UP','IN_TRANSIT','RETURNING'],
 PICKED_UP:['IN_TRANSIT','OUT_FOR_DELIVERY','RETURNING'],
 IN_TRANSIT:['OUT_FOR_DELIVERY','POSTPONED','RETURNING'],
 OUT_FOR_DELIVERY:['DELIVERED','REFUSED','POSTPONED','RETURNING'],
 POSTPONED:['OUT_FOR_DELIVERY','REFUSED','RETURNING'],
 REFUSED:['RETURNING'], RETURNING:['RETURNED'],
 DELIVERED:[],RETURNED:[],CANCELLED:[]
};
export function canTransition(from,to){return from===to || (transitions[from]||[]).includes(to);}
// External systems frequently omit intermediate milestones. Accept forward jumps
// while rejecting impossible terminal reversals and stale backwards updates.
export function canPartnerTransition(from,to){
 if(from===to)return true;
 if(['DELIVERED','RETURNED','CANCELLED'].includes(from))return false;
 if(to==='DELIVERED')return !['REFUSED','RETURNING'].includes(from);
 if(to==='REFUSED')return ['ASSIGNED_PARTNER','EXPORTED','HANDED_OVER','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','POSTPONED'].includes(from);
 if(to==='RETURNING')return ['HANDED_OVER','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','POSTPONED','REFUSED'].includes(from);
 if(to==='RETURNED')return ['REFUSED','RETURNING'].includes(from);
 if(to==='POSTPONED')return ['PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY'].includes(from);
 if(from==='POSTPONED'&&to==='OUT_FOR_DELIVERY')return true;
 const steps=['ASSIGNED_PARTNER','EXPORTED','HANDED_OVER','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY'];
 const a=steps.indexOf(from),b=steps.indexOf(to);
 return a>=0&&b>=0&&b>a;
}
export function mapPartnerStatus(raw,custom={}){
 const normalized=String(raw||'').trim().toUpperCase().replace(/[\s-]+/g,'_');
 const mappings={ATTEND_DE_RAMASSAGE:'ASSIGNED_PARTNER',EN_ATTENTE_DE_RAMASSAGE:'ASSIGNED_PARTNER',
  RAMASSE:'PICKED_UP',RAMASSÉ:'PICKED_UP',PICKED:'PICKED_UP',EN_COURS:'IN_TRANSIT',
  EN_LIVRAISON:'OUT_FOR_DELIVERY',LIVRE:'DELIVERED',LIVRÉ:'DELIVERED',
  REFUSE:'REFUSED',REFUSÉ:'REFUSED',RETOUR:'RETURNING',RETOURNE:'RETURNED',
  REPORTÉ:'POSTPONED',REPORTE:'POSTPONED'};
 const result=custom[normalized]||mappings[normalized]||normalized;
 return STATUSES.includes(result)?result:null;
}
export const centimes = value => {
 const num=Number(value); if(!Number.isFinite(num)||num<0||num>10000000)throw Error('Montant COD invalide');
 return Math.round(num*100);
};
export function validTracking(x){return /^[A-Za-z0-9_-]{4,64}$/.test(String(x||''));}
