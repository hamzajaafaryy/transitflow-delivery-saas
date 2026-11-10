import { z } from 'zod';
import type { Transaction } from './db.js';
import { uuid } from './http.js';
import type { Context } from './security/session.js';

export async function notify(db:Transaction,recipients:string[],group:string,title:string,entityId:string|null) {
  await db.query(`INSERT INTO v2_notifications(recipient_id,group_key,title,entity_id)
    SELECT id,$2,$3,$4 FROM v2_users WHERE id=ANY($1::uuid[]) AND active
    ON CONFLICT(recipient_id,group_key) DO UPDATE SET title=excluded.title,entity_id=excluded.entity_id,
      read_at=NULL,cleared_at=NULL,updated_at=clock_timestamp()`,[recipients,group,title,entityId]);
}

export async function notifyMerchant(db:Transaction,merchantId:string,group:string,title:string,entityId:string) {
  const {rows}=await db.query<{id:string}>('SELECT id FROM v2_users WHERE merchant_id=$1 AND active',[merchantId]);
  await notify(db,rows.map(row=>row.id),group,title,entityId);
}

export async function clearNotice(db:Transaction,group:string) {
  await db.query('UPDATE v2_notifications SET cleared_at=clock_timestamp() WHERE group_key=$1 AND cleared_at IS NULL',[group]);
}

export function notificationRoutes(ctx:Context) {
  const { app,pool }=ctx;
  app.get('/api/v2/notifications',async request=>{
    const user=await ctx.user(request);
    const {rows}=await pool.query(`SELECT id,group_key,title,entity_id,read_at,updated_at,
      COUNT(*) FILTER(WHERE read_at IS NULL) OVER()::int AS unread
      FROM v2_notifications WHERE recipient_id=$1 AND cleared_at IS NULL
      ORDER BY read_at IS NOT NULL,updated_at DESC,id LIMIT 100`,[user.id]);
    return { rows,unread:rows[0]?.unread??0 };
  });
  app.post('/api/v2/notifications/read',async request=>{
    const user=await ctx.user(request);
    const {id}=z.object({id:uuid.optional()}).strict().parse(request.body);
    await pool.query(`UPDATE v2_notifications SET read_at=clock_timestamp()
      WHERE recipient_id=$1 AND ($2::uuid IS NULL OR id=$2) AND read_at IS NULL AND cleared_at IS NULL`,[user.id,id??null]);
    return { read:true };
  });
}
