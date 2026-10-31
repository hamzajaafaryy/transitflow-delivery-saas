import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const QRCode = require('./vendor/qrcode/index.cjs');
const QRLevel = require('./vendor/qrcode/QRErrorCorrectLevel.cjs');
const CODE128_PATTERNS = 'BaBbBb|BbBaBb|BbBbBa|AbAbBc|AbAcBb|AcAbBb|AbBbAc|AbBcAb|AcBbAb|BbAbAc|BbAcAb|BcAbAb|AaBbCb|AbBaCb|AbBbCa|AaCbBb|AbCaBb|AbCbBa|BbCbAa|BbAaCb|BbAbCa|BaCbAb|BbCaAb|CaBaCa|CaAbBb|CbAaBb|CbAbBa|CaBbAb|CbBaAb|CbBbAa|BaBaBc|BaBcBa|BcBaBa|AaAcBc|AcAaBc|AcAcBa|AaBcAc|AcBaAc|AcBcAa|BaAcAc|BcAaAc|BcAcAa|AaBaCc|AaBcCa|AcBaCa|AaCaBc|AaCcBa|AcCaBa|CaCaBa|BaAcCa|BcAaCa|BaCaAc|BaCcAa|BaCaCa|CaAaBc|CaAcBa|CcAaBa|CaBaAc|CaBcAa|CcBaAa|CaDaAa|BbAdAa|DcAaAa|AaAbBd|AaAdBb|AbAaBd|AbAdBa|AdAaBb|AdAbBa|AaBbAd|AaBdAb|AbBaAd|AbBdAa|AdBaAb|AdBbAa|BdAbAa|BbAaAd|DaCaAa|BdAaAb|AcDaAa|AaAbDb|AbAaDb|AbAbDa|AaDbAb|AbDaAb|AbDbAa|DaAbAb|DbAaAb|DbAbAa|BaBaDa|BaDaBa|DaBaBa|AaAaDc|AaAcDa|AcAaDa|AaDaAc|AaDcAa|DaAaAc|DaAcAa|AaCaDa|AaDaCa|CaAaDa|DaAaCa|BaAdAb|BaAbAd|BaAbCb|BcCaAaB'.split('|');
const escapeHtml=(text)=>String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function code128Svg(text){
  const input=String(text);
  if(!input.length||input.length>64||!/^[\x20-\x7E]+$/.test(input))throw new Error('Code-barres Code 128 B: caractères non pris en charge');
  const codes=[104]; let sum=104;
  for(let i=0;i<input.length;i++){const value=input.charCodeAt(i)-32;codes.push(value);sum+=value*(i+1);}
  codes.push(sum%103,106);
  let x=10;const bars=[];
  for(const code of codes){const pattern=CODE128_PATTERNS[code];for(const c of pattern){const width=c.toLowerCase().charCodeAt(0)-96; if(c===c.toUpperCase())bars.push(`<rect x="${x}" y="0" width="${width}" height="65"/>`);x+=width;}}
  const width=x+10;
  return `<svg class="code128" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 65" role="img" aria-label="Code-barres ${escapeHtml(input)}"><rect width="${width}" height="65" fill="white"/>${bars.join('')}</svg>`;
}

export function qrSvg(text){
 const qr=new QRCode(-1,QRLevel.M);qr.addData(String(text));qr.make();
 const n=qr.getModuleCount(),q=4,rects=[];
 for(let row=0;row<n;row++)for(let col=0;col<n;col++)if(qr.isDark(row,col))rects.push(`M${col+q} ${row+q}h1v1h-1z`);
 return `<svg class="qrcode" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n+2*q} ${n+2*q}" role="img" aria-label="QR code suivi"><rect width="100%" height="100%" fill="white"/><path d="${rects.join('')}" fill="black"/></svg>`;
}

const fmtMoney=(cents)=>new Intl.NumberFormat('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(cents||0)/100)+' DH';
export function ticketHtml({shipment,company,merchantName='',partnerName='',trackingUrl}){
 const sh=shipment, e=escapeHtml;
 const label=partnerName||'Livraison interne';
 const qr=qrSvg(trackingUrl);
 const barcode=code128Svg(sh.tracking);
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket ${e(sh.tracking)}</title>
<style>@page{size:100mm 150mm;margin:0}*{box-sizing:border-box}body{margin:0;background:#e8eaed;color:#151515;font-family:Arial,Helvetica,sans-serif}main{background:white;width:100mm;min-height:150mm;margin:18px auto;padding:5mm 5mm 4mm;border:1px solid #ccc}header{display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:3mm;gap:8mm}header strong{font-size:19px;letter-spacing:-.5px}header small{font-size:10px;display:block;margin-top:5px}h1{font-size:14px;margin:0}table{border-collapse:collapse;width:100%;margin-top:4mm}th,td{border:1px solid #222;padding:5px;text-align:left;font-size:11px;word-break:break-word}th{width:29%;font-weight:700}.route{margin-top:4mm;display:flex;align-items:center;gap:4mm}.partner{border:2px solid #111;padding:9px;font-weight:800;font-size:13px;min-width:36mm;text-align:center}.qrcode{width:29mm;height:29mm}.code128{width:100%;height:21mm;display:block}.tracking{text-align:center;font-weight:800;font-size:16px;letter-spacing:1px;margin:4mm 0 1mm}.cod{border:2px solid #111;padding:7px;font-weight:900;text-align:center;font-size:18px}.footer{margin-top:3mm;border:1px solid #111;text-align:center;font-weight:700;padding:7px;font-size:11px}.meta{margin-top:3mm;font-size:10px;color:#555}.print-note{max-width:100mm;margin:10px auto;padding:10px;background:white;border-radius:6px;font-size:12px}@media print{body{background:white}main{margin:0;border:0;box-shadow:none}.print-note{display:none}}</style></head><body>
<div class="print-note">Ticket prêt à imprimer — utilisez « Imprimer » dans votre navigateur ou « Enregistrer au format PDF ». Format 100 × 150 mm.</div><main><header><div><strong>${e(company.name)}</strong><small>${e(merchantName||'Expéditeur non précisé')}</small></div><h1>COLIS / LIVRAISON</h1></header>
<table><tbody><tr><th>Destinataire</th><td>${e(sh.recipient)}</td></tr><tr><th>Téléphone</th><td>${e(sh.phone)}</td></tr><tr><th>Ville</th><td>${e(sh.city)}</td></tr><tr><th>Adresse</th><td>${e(sh.address)}</td></tr><tr><th>Marchandise</th><td>${e(sh.description||'Non précisée')}</td></tr></tbody></table>
<div class="route"><div class="partner">${e(label)}</div>${qr}</div><div class="tracking">${e(sh.tracking)}</div>${barcode}<div class="cod">CRBT : ${fmtMoney(sh.cod_centimes)}</div><div class="footer">COLIS NORMAL · OUVERTURE NON PRÉCISÉE</div><div class="meta">Créé le ${e(sh.created_at?.slice(0,16).replace('T',' '))} · Ref. ${e(sh.tracking)}</div></main></body></html>`;
}
export function publicTrackingHtml({tracking,status,statusLabel,city,updatedAt,events=[]}){
 const e=escapeHtml;
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suivi ${e(tracking)} — TransitFlow</title><style>*{box-sizing:border-box}body{margin:0;font:15px system-ui,Arial,sans-serif;background:#f4f7fb;color:#192945}header{background:#152742;color:white;padding:23px max(calc((100vw - 680px)/2),20px);font-weight:800;font-size:23px}.card{max-width:680px;margin:35px auto;background:white;padding:30px;border-radius:18px;box-shadow:0 12px 34px #1835540f}h1{font-size:22px}h2{font-size:16px}.tag{background:#e7efff;color:#274eba;border-radius:20px;padding:9px 15px;display:inline-block;font-weight:700}small{color:#738296}.event{padding:16px 0;border-bottom:1px solid #e8edf4}.event strong{display:block;margin-bottom:6px}@media(max-width:720px){.card{margin:15px;padding:20px}}</style></head><body><header>TransitFlow</header><main class="card"><h1>Suivi de votre colis</h1><p><strong>${e(tracking)}</strong> · ${e(city)}</p><p><span class="tag">${e(statusLabel||status)}</span></p><p><small>Dernière mise à jour : ${e(updatedAt||'—')}</small></p><h2>Historique de livraison</h2>${events.map(x=>`<div class="event"><strong>${e(x.label||x.status)}</strong><small>${e(x.created_at)}</small></div>`).join('')}</main></body></html>`;
}
