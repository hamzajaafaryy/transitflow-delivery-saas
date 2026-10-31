import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const tool=resolve(dirname(fileURLToPath(import.meta.url)),'../scripts/excel.py');
export function xlsx(mode,input){
 const proc=spawnSync('python3',[tool,mode],{input:mode==='export'?JSON.stringify(input):input,maxBuffer:15_000_000,timeout:12000});
 if(proc.status!==0)throw Error(`Excel: ${proc.stderr?.toString().slice(0,150)||'Conversion impossible'}`);
 return mode==='export'?proc.stdout:JSON.parse(proc.stdout.toString('utf8'));
}
export const orderColumns=['Tracking','Destinataire','Téléphone','Adresse','Ville','COD','Description'];
export function parseCsv(text){
 let rows=[],row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
  else if(!quoted&&c===','){row.push(field);field='';}
  else if(!quoted&&(c==='\n'||c==='\r')){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x!==''))rows.push(row);row=[];field='';}
  else field+=c;
 }row.push(field);if(row.some(x=>x!==''))rows.push(row);
 if(quoted)throw Error('CSV non fermé');return rows;
}
export function rowsToOrders(rows){
 if(!Array.isArray(rows)||rows.length<2)throw Error('Fichier vide');
 const headers=rows[0].map(x=>String(x).trim().toLowerCase());
 const fields={tracking:['tracking','code','code bar','barcode','numéro'],recipient:['destinataire','client','nom','recipient'],phone:['téléphone','telephone','phone','mobile'],address:['adresse','address'],city:['ville','city'],cod:['cod','prix','montant'],description:['description','produit','product']};
 const idx={};for(const [name,aliases] of Object.entries(fields)){idx[name]=headers.findIndex(h=>aliases.includes(h));if(idx[name]<0&&name!=='description'&&name!=='cod')throw Error(`Colonne manquante: ${aliases[0]}`);}
 return rows.slice(1).filter(r=>r.some(x=>String(x).trim())).map((r,i)=>({line:i+2,tracking:String(r[idx.tracking]||'').trim(),recipient:String(r[idx.recipient]||'').trim(),phone:String(r[idx.phone]||'').trim(),address:String(r[idx.address]||'').trim(),city:String(r[idx.city]||'').trim(),cod:idx.cod<0?0:Number(String(r[idx.cod]||'0').replace(',','.')),description:idx.description<0?'':String(r[idx.description]||'')}));
}
