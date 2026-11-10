import { z } from 'zod';
import { one, type Transaction } from './db.js';
import { code, date, key, missing, text } from './http.js';
import type { Principal } from './security/authorization.js';

export const statuses = [
 'MANQUE_STOCK','ATTENTE_RAMASSAGE','RAMASSE','EXPEDIE','RECU_VILLE','MISE_EN_DISTRIBUTION',
 'LIVRE','REFUSE','ANNULE','PAS_DE_REPONSE','DEUXIEME_APPEL','TROISIEME_APPEL','REPORTE','RETOUR_AUTORISE',
] as const;
export type Status = typeof statuses[number];
export const lastMile = z.enum(['RECU_VILLE','MISE_EN_DISTRIBUTION','LIVRE','REFUSE','ANNULE','PAS_DE_REPONSE','DEUXIEME_APPEL','TROISIEME_APPEL','REPORTE']);
export const packaging = z.enum(['SACHET_PETIT','SACHET_GRAND','CARTON_PETIT','CARTON_GRAND']);
export const scanInput = z.object({
  trackingCode:code, requestKey:key, method:z.enum(['MANUAL','BARCODE','CAMERA']), confirmed:z.literal(true).optional(),
}).strict();

export interface Order {
  id: string;
  tracking_code: string;
  merchant_id: string;
  agency_id: string | null;
  source: 'EXTERNAL'|'STOCK';
  status: Status;
  city: string;
  cod_centimes: string;
  packaging_centimes: string;
  delivery_fee_centimes: string;
  refused_fee_centimes: string;
  current_holder_type: string | null;
  current_holder_id: string | null;
  status_updated_at: Date;
  delivered_at: Date | null;
  is_exchange: boolean;
}
export type Scan = z.infer<typeof scanInput>;

export function normalizeCity(value: string) {
  return value.normalize('NFC').trim().replace(/\s+/g,' ').toLocaleLowerCase('fr-MA');
}

export async function mainWarehouse(db: Transaction) {
  const row = await one<{ id: string }>(db,'SELECT id FROM v2_warehouses WHERE is_main');
  if (!row) throw new Error('Main warehouse is missing');
  return row.id;
}

export async function activeAgency(db: Transaction, id: string) {
  const agency = await one<{ id:string; name:string; city:string; return_excel_header:string; dispatch_excel_headers:string[] }>(
    db,'SELECT * FROM v2_agencies WHERE id=$1 AND active',[id]);
  if (!agency) throw missing('Agence introuvable.');
  return agency;
}

export async function statusEvent(db: Transaction, order: Order, status: Status, user: Principal | null,
  source: 'OPERATIONS'|'CORRECTION'|'PARTNER', occurredAt = new Date(), reason?: string) {
  if (order.status===status) return;
  await db.query(`UPDATE v2_orders SET status=$2,status_updated_at=$3,
    delivered_at=CASE WHEN $2='LIVRE' THEN COALESCE(delivered_at,$3) ELSE NULL END WHERE id=$1`,[order.id,status,occurredAt]);
  await db.query(`INSERT INTO v2_order_events(order_id,status,source,reason,occurred_at,actor_id)
    VALUES($1,$2,$3,$4,$5,$6)`,[order.id,status,source,reason ?? null,occurredAt,user?.id ?? null]);
}

export const filterWindow = { from:date.optional(), to:date.optional(), search:text(120).optional() };
