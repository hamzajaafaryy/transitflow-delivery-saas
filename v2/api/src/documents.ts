import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ApiError } from './http.js';
import { casablancaZone } from './sla.js';

const require = createRequire(import.meta.url);
const { code128Svg } = require('../../../src/ticket.mjs') as { code128Svg(value: string): string };
const xlsxScript = fileURLToPath(new URL('../scripts/xlsx.py',import.meta.url));

export const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const pdfMime = 'application/pdf';

async function xlsx(mode: 'import'|'export', input: Buffer) {
  return new Promise<Buffer>((resolve,reject) => {
    const child = spawn('python3',['-I',xlsxScript,mode],{ stdio:['pipe','pipe','ignore'],timeout:18_000 });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data',(chunk: Buffer) => {
      size += chunk.length;
      if (size > 40_000_000) child.kill();
      else chunks.push(chunk);
    });
    child.on('error',reject);
    child.on('close',exitCode => {
      if (exitCode === 0) resolve(Buffer.concat(chunks));
      else reject(new ApiError(422,'XLSX_INVALID','Le fichier Excel est invalide ou dépasse les limites de traitement.'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

export async function readWorkbook(bytes: Buffer): Promise<string[][]> {
  return JSON.parse((await xlsx('import',bytes)).toString('utf8')) as string[][];
}

export async function workbook(headers: string[], rows: unknown[][]) {
  return xlsx('export',Buffer.from([headers,...rows].map(row => JSON.stringify(row)).join('\n')));
}

export const localDate = (time: string | Date) => new Intl.DateTimeFormat('fr-MA',{
  dateStyle:'short', timeStyle:'short', timeZone:casablancaZone(new Date(time)),
}).format(new Date(time));
const lineText = (value: unknown, length = 84) => String(value ?? '').replace(/\s+/g,' ')
  .replace(/[^\x20-\x7e\xa0-\xff–—’€]/g,'·').slice(0,length);
const ink = rgb(0.08,0.16,0.23);

export async function bonPdf(input: {
  title: string; id: string; name: string; date: Date | string;
  rows: { tracking_code: string; damaged?: boolean; is_exchange?: boolean; input_method?: string | null }[];
  merchant?: boolean; revision?: number;
}) {
  const document = await PDFDocument.create();
  document.setTitle(input.title);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const perPage = 27;
  const pages = Math.max(1,Math.ceil(input.rows.length / perPage));
  const copies = input.merchant ? ['Exemplaire exploitation','Exemplaire marchand'] : [''];
  for (const copy of copies) {
    for (let index=0; index<pages; index++) {
      const page = document.addPage([595.28,841.89]);
      const draw = (value: string, x: number, y: number, size=11, strong=false) =>
        page.drawText(lineText(value),{ x,y,size,font:strong?bold:regular,color:ink });
      draw('TRANSITFLOW',42,795,12,true);
      draw(input.title,42,767,23,true);
      draw(input.name,42,740,13,true);
      draw(`Bon ${input.id}`,42,720);
      draw(`${localDate(input.date)}  |  ${input.rows.length} colis${input.revision?`  |  Révision ${input.revision}`:''}`,42,700);
      draw(copy,42,680);
      page.drawRectangle({x:40,y:640,width:515,height:24,color:rgb(0.92,0.95,0.97)});
      draw('CODE SUIVI',50,648,10,true);
      draw('OBSERVATIONS',250,648,10,true);
      for (const [i,row] of input.rows.slice(index*perPage,(index+1)*perPage).entries()) {
        const y=622-i*18.8;
        draw(row.tracking_code,50,y,10,true);
        draw([row.is_exchange?'ÉCHANGE':'',row.damaged?'ENDOMMAGÉ':'',row.input_method==='MANUAL'?'Saisie manuelle':''].filter(Boolean).join(' / '),250,y,10);
        page.drawLine({ start:{x:42,y:y-5},end:{x:553,y:y-5},thickness:0.4,color:rgb(0.84,0.89,0.92) });
      }
      if (input.merchant && index===pages-1) {
        draw('Signature du marchand',42,71,10,true);
        page.drawLine({ start:{x:42,y:53},end:{x:240,y:53},thickness:0.6,color:ink });
      }
      draw(`Page ${index+1} / ${pages}`,470,43,10);
    }
  }
  return document.save();
}

export async function ticketPdf(rows: {
  tracking_code: string; recipient: string; phone: string; address: string; city: string;
  merchant: string; cod_centimes: string; can_open: boolean; is_exchange: boolean; source: string;
}[]) {
  const document = await PDFDocument.create();
  document.setTitle('TransitFlow · Tickets 100 × 100 mm');
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  for (const row of rows) {
    const page = document.addPage([100/25.4*72,100/25.4*72]);
    const draw = (value: string,y: number,size: number,strong=false,length=48) =>
      page.drawText(lineText(value,length),{x:13,y,size,font:strong?bold:regular,color:ink});
    draw('TRANSITFLOW',260,15,true);
    draw(`${row.merchant} · ${row.source==='STOCK'?'STOCK':'RAMASSAGE'}`,242,9);
    draw(row.recipient,215,12,true,37);
    draw(row.phone,197,12,true);
    const address = lineText(row.address,160);
    for (let i=0;i<3;i++) draw(address.slice(i*52,(i+1)*52),180-i*12,9);
    draw(row.city,136,16,true,30);
    draw(`COD  ${(Number(row.cod_centimes)/100).toFixed(2)} MAD`,115,14,true);
    draw([row.can_open?'OUVERTURE AUTORISÉE':'NE PAS OUVRIR',row.is_exchange?'ÉCHANGE':''].filter(Boolean).join(' · '),96,9);
    const svg = code128Svg(row.tracking_code);
    const width = Number(svg.match(/viewBox="0 0 (\d+) 65"/)?.[1]);
    const scale = 254 / width;
    for (const bar of svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="65"\/>/g)) {
      page.drawRectangle({x:14+Number(bar[1])*scale,y:32,width:Number(bar[2])*scale,height:45,color:rgb(0,0,0)});
    }
    draw(row.tracking_code,15,10,true,64);
  }
  return document.save();
}
