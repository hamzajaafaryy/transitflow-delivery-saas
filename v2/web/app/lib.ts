export interface User {
  id:string;
  role:string;
  displayName:string;
  agencyId?:string;
  merchantId?:string;
  permissions:string[];
}
export interface Row { id:string;[key:string]:unknown }
export interface Reference { id:string;name:string;city?:string }
export interface References { agencies:Reference[];merchants:Reference[];cities:string[] }
export interface PageRows { rows:Row[];total:number;page:number }
export const emptyReferences={ agencies:[],merchants:[],cities:[] };
export const label:Record<string,string>={
  MANQUE_STOCK:'Manque de stock',ATTENTE_RAMASSAGE:'Attente de ramassage',RAMASSE:'Ramassé',EXPEDIE:'Expédié',
  RECU_VILLE:'Reçu par ville',MISE_EN_DISTRIBUTION:'Mise en distribution',LIVRE:'Livré',REFUSE:'Refusé',ANNULE:'Annulé',
  PAS_DE_REPONSE:'Pas de réponse',DEUXIEME_APPEL:'2ème appel',TROISIEME_APPEL:'3ème appel',REPORTE:'Reporté',RETOUR_AUTORISE:'Retour autorisé',
  BROUILLON:'Brouillon',ENVOYE:'Envoyé',RECU:'Reçu',EN_PREPARATION:'En préparation',
  EXPEDIE_VERS_CLIENT:'Expédié vers client',EN_ATTENTE_CONFIRMATION:'En attente de confirmation marchand',
  CONFIRME_PAR_MARCHAND:'Confirmé par marchand',RECU_PAR_CLIENT:'Reçu par client',
  PAYE:'Payé',EN_COURS_TRAITEMENT:'En cours de traitement',EN_ATTENTE:'En attente',AFFECTE:'Affecté',PICKED:'Collecté',TERMINE:'Terminé',
  OUVERTE:'Ouverte',EN_COURS:'En cours',RESOLUE:'Résolue',FERMEE:'Fermée',ESCALADEE:'Escaladée',ANNULEE:'Annulée',
  EXTERNAL:'Externe',STOCK:'Stock',MERCHANT:'Marchand',PARTNER_AGENCY:'Agence partenaire',EMPLOYEE:'Employé',
  ADMIN:'Administration',RESPONSABLE:'Responsable',DEVELOPER:'Développeur',AGENCY:'Agence',WAREHOUSE:'Entrepôt',DRIVER:'Livreur',
  ORDER:'Commande',PICKUP:'Ramassage',INVOICE:'Relevé',SETTLEMENT:'Paiement',RETURN:'Retour',OTHER:'Autre',
  PRESENTE:'Présent',TT:'Télétravail',ABSENTE:'Absent',CODE_INCONNU:'Code inconnu',HORS_AGENCE:'Hors agence',FORMAT_INVALIDE:'Format invalide',
};
export const orderStatuses=['MANQUE_STOCK','ATTENTE_RAMASSAGE','RAMASSE','EXPEDIE','RECU_VILLE','MISE_EN_DISTRIBUTION','LIVRE','REFUSE',
  'ANNULE','PAS_DE_REPONSE','DEUXIEME_APPEL','TROISIEME_APPEL','REPORTE','RETOUR_AUTORISE'];
export const packagingKinds=['SACHET_PETIT','SACHET_GRAND','CARTON_PETIT','CARTON_GRAND'];
export const fmt=(value:unknown)=>String(value??'');
export const display=(value:unknown)=>label[fmt(value)]||fmt(value)||'—';
export const short=(id:unknown)=>fmt(id).slice(0,8).toUpperCase();
export const money=(value:unknown)=>new Intl.NumberFormat('fr-MA',{style:'currency',currency:'MAD'}).format(Number(value??0)/100);
export const moroccoZone=(date:Date)=>+date>=Date.parse('2026-09-20T01:00:00Z')?'UTC':'Africa/Casablanca';
export const when=(value:unknown)=>value?new Intl.DateTimeFormat('fr-MA',{
  dateStyle:'short',timeStyle:'short',timeZone:moroccoZone(new Date(String(value))),
}).format(new Date(String(value))):'—';
export const normalizeCodes=(value:string)=>[...new Set(value.toUpperCase().split(/[\s,;]+/).filter(Boolean))];

export function can(user:User,permission:string) {
  if (permission==='agency_payments.confirm_paid') {
    return user.role==='ADMIN'||user.role==='RESPONSABLE'&&user.permissions.includes(permission);
  }
  return ['ADMIN','DEVELOPER'].includes(user.role)||user.permissions.includes(permission)||
    user.permissions.includes('returns.manage')&&['returns.scan','returns.read','merchant_returns.read','merchant_returns.manage','claims.manage'].includes(permission);
}

export class ApiError extends Error {
  constructor(message:string, public code:string, public status:number, public details?:Record<string,unknown>) {
    super(message);
  }
}

export async function api<T>(path:string, data?:unknown, method=data===undefined?'GET':'POST',signal?:AbortSignal):Promise<T> {
  const response=await fetch('/api/v2'+path,{
    method,signal,cache:'no-store',credentials:'same-origin',
    headers:{'X-TransitFlow-Request':'1','X-TransitFlow-Origin':window.location.origin,...(data!==undefined&&!(data instanceof FormData)?{'Content-Type':'application/json'}:{})},
    body:data===undefined?undefined:data instanceof FormData?data:JSON.stringify(data),
  });
  if (response.status===204) return undefined as T;
  const result=await response.json().catch(()=>null);
  if (!response.ok) throw new ApiError(result?.message||'La connexion au service a échoué.',result?.code||'CONNECTION',response.status,result?.details);
  return result as T;
}
export function href(path:string,values:Record<string,string|number|undefined>={}) {
  const query=new URLSearchParams();
  for (const [key,value] of Object.entries(values)) if (value!==undefined&&value!=='') query.set(key,String(value));
  return path+(query.size?'?'+query.toString():'');
}

export function dateBoundary(day:string) {
  if (!day) return '';
  if (day>='2026-09-21') return day+'T00:00:00Z';
  const [year,month,date]=day.split('-').map(Number);
  const target=Date.UTC(year,month-1,date);
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Casablanca',timeZoneName:'longOffset'});
  const zone=formatter.formatToParts(new Date(target)).find(part=>part.type==='timeZoneName')?.value??'GMT';
  const offset=zone==='GMT'?'+00:00':zone.replace('GMT','');
  return day+'T00:00:00'+offset;
}

export async function attachment(file:File|undefined) {
  if (!file || file.size===0) return undefined;
  if (file.size>2_000_000) throw new Error('Choisissez un fichier de 2 Mo maximum.');
  const source=await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result));
    reader.onerror=()=>reject(new Error('Lecture du fichier impossible.'));
    reader.readAsDataURL(file);
  });
  return { mime:file.type,base64:source.split(',')[1] };
}
