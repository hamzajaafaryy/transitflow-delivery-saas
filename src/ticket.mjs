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
const labelStyle=`@page{size:100mm 100mm;margin:0}*{box-sizing:border-box}body{margin:0;background:#e8eaed;color:#111;font-family:Arial,Helvetica,sans-serif}.ticket{background:#fff;width:100mm;height:100mm;padding:3mm 4mm;margin:12px auto;display:flex;flex-direction:column;gap:1.5mm;break-inside:avoid;break-after:page;overflow:hidden}.ticket:last-child{break-after:auto}.ticket.dense{gap:1mm}.ticket.dense .address{font-size:8px;line-height:1.1}.ticket.dense .description{font-size:8px;line-height:1.1}.ticket.dense .recipient{font-size:11px}.ticket.dense .code128{height:12mm}.ticket header{display:flex;justify-content:space-between;gap:2mm;border-bottom:1.5px solid #111;padding-bottom:1.5mm}.ticket header strong{font-size:13px}.ticket header small{display:block;font-size:9px;margin-top:1mm}.source{font-size:9px;font-weight:bold;max-width:35mm;text-align:right}.recipient{font-size:13px;font-weight:bold}.phone{font-size:14px;font-weight:bold}.address{font-size:10px;line-height:1.25;overflow-wrap:anywhere}.city{font-size:17px;font-weight:900}.route{display:flex;gap:2mm;align-items:center;min-height:20mm}.route-info{flex:1}.agency{font-size:9px}.description{font-size:9px;line-height:1.25;overflow-wrap:anywhere}.qrcode{width:20mm;height:20mm;flex:none}.tracking{text-align:center;font-size:12px;font-weight:bold;letter-spacing:.3px;margin-top:auto}.code128{width:100%;height:15mm;flex:none}.cod{border:1.5px solid #111;text-align:center;font-size:16px;font-weight:900;padding:1mm}.footer{display:flex;justify-content:space-between;gap:1mm;font-size:8px;font-weight:bold}.print-note{max-width:100mm;margin:12px auto;background:white;padding:12px;font-size:12px}.print-note button{padding:8px 14px;margin-top:8px;cursor:pointer}@media print{body{background:#fff}.ticket{margin:0}.print-note{display:none}}`;
function labelMarkup(sh,company,trackingUrl){
 const e=escapeHtml;
 return `<article class="ticket${sh.address.length>180||(sh.description||'').length>100||sh.recipient.length>80?' dense':''}" data-tracking="${e(sh.tracking)}"><header><div><strong>${e(company.name)}</strong><small>${e(sh.merchant_name||'Expéditeur non précisé')}</small></div><span class="source">${sh.order_source==='STOCK'?'COMMANDE STOCK':'COMMANDE RAMASSAGE'}</span></header><div class="recipient">${e(sh.recipient)}</div><div class="phone">${e(sh.phone)}</div><div class="address">${e(sh.address)}</div><div class="route"><div class="route-info"><div class="city">${e(sh.city)}</div><div class="agency">${e(sh.agency_name||'Livraison interne')}</div><div class="description">${e(sh.description||'1 colis')}</div></div>${qrSvg(trackingUrl)}</div><div class="tracking">${e(sh.tracking)}</div>${code128Svg(sh.tracking)}<div class="cod">CRBT : ${fmtMoney(sh.cod_centimes)}</div><div class="footer"><span>${sh.fragile?'FRAGILE':'COLIS NORMAL'}</span><span>${sh.allow_open?'OUVERTURE AUTORISÉE':'NE PAS OUVRIR'}</span></div></article>`;
}
export function ticketsHtml({shipments,company,publicBase='http://localhost:3000'}){
 const origin=new URL(publicBase).origin;
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tickets ${shipments.length} colis</title><style>${labelStyle}</style></head><body><div class="print-note"><strong>${shipments.length} ticket(s) · 100 × 100 mm</strong><br>Imprimez à 100 %, sans marges ni en-têtes. Chaque colis occupe une page.<br><button onclick="window.print()">Imprimer les tickets / PDF</button></div>${shipments.map(s=>labelMarkup(s,company,origin+'/suivi/'+encodeURIComponent(s.tracking))).join('')}</body></html>`;
}
export function ticketHtml({shipment,company,merchantName='',agencyName='',trackingUrl}){
 return ticketsHtml({shipments:[{...shipment,merchant_name:merchantName,agency_name:agencyName}],company,publicBase:trackingUrl});
}
export function publicTrackingHtml({tracking,status,statusLabel,city,updatedAt,events=[]}){
 const e=escapeHtml;
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suivi ${e(tracking)} — TransitFlow</title><style>*{box-sizing:border-box}body{margin:0;font:15px system-ui,Arial,sans-serif;background:#f4f7fb;color:#192945}header{background:#152742;color:white;padding:23px max(calc((100vw - 680px)/2),20px);font-weight:800;font-size:23px}.card{max-width:680px;margin:35px auto;background:white;padding:30px;border-radius:18px;box-shadow:0 12px 34px #1835540f}h1{font-size:22px}h2{font-size:16px}.tag{background:#e7efff;color:#274eba;border-radius:20px;padding:9px 15px;display:inline-block;font-weight:700}small{color:#738296}.event{padding:16px 0;border-bottom:1px solid #e8edf4}.event strong{display:block;margin-bottom:6px}@media(max-width:720px){.card{margin:15px;padding:20px}}</style></head><body><header>TransitFlow</header><main class="card"><h1>Suivi de votre colis</h1><p><strong>${e(tracking)}</strong> · ${e(city)}</p><p><span class="tag">${e(statusLabel||status)}</span></p><p><small>Dernière mise à jour : ${e(updatedAt||'—')}</small></p><h2>Historique de livraison</h2>${events.map(x=>`<div class="event"><strong>${e(x.label||x.status)}</strong><small>${e(x.created_at)}</small></div>`).join('')}</main></body></html>`;
}
