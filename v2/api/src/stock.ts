import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { lock, one, transaction, type Transaction } from './db.js';
import { statusEvent, type Order } from './domain.js';
import { conflict, forbidden, missing, param, text, uuid } from './http.js';
import type { Principal } from './security/authorization.js';
import { audit, check, ownScope, type Context } from './security/session.js';

export async function stockLock(db: Transaction, merchantId: string) {
  await lock(db,'stock',merchantId);
}

export async function reserveStock(db: Transaction, order: Order) {
  const lots = (await db.query<{ lot_id:string; product_id:string; available:number }>(`SELECT l.id AS lot_id,l.product_id,l.physical-l.reserved AS available
    FROM v2_stock_lots l JOIN v2_stock_order_items i ON i.product_id=l.product_id AND i.order_id=$1
    WHERE l.physical>l.reserved ORDER BY l.created_at,l.id`,[order.id])).rows;
  const items = (await db.query<{ product_id:string; quantity:number }>('SELECT product_id,quantity FROM v2_stock_order_items WHERE order_id=$1',[order.id])).rows;
  if (!items.length || items.some(item => lots.filter(lot=>lot.product_id===item.product_id).reduce((sum,lot)=>sum+lot.available,0)<item.quantity)) return false;
  for (const item of items) {
    let remaining = item.quantity;
    for (const lot of lots.filter(row=>row.product_id===item.product_id)) {
      if (remaining===0) break;
      const quantity=Math.min(remaining,lot.available);
      await db.query('UPDATE v2_stock_lots SET reserved=reserved+$2 WHERE id=$1',[lot.lot_id,quantity]);
      await db.query('INSERT INTO v2_stock_allocations(order_id,lot_id,quantity) VALUES($1,$2,$3)',[order.id,lot.lot_id,quantity]);
      remaining-=quantity;
    }
  }
  return true;
}

async function reconsiderShortages(db: Transaction, merchantId: string, user: Principal) {
  const orders=(await db.query<Order>(`SELECT * FROM v2_orders WHERE merchant_id=$1 AND status='MANQUE_STOCK' AND source='STOCK'
    ORDER BY created_at,id FOR UPDATE`,[merchantId])).rows;
  for (const order of orders) {
    if (await reserveStock(db,order)) await statusEvent(db,order,'ATTENTE_RAMASSAGE',user,'OPERATIONS');
  }
}

export async function releaseStock(db: Transaction, orderId: string) {
  await db.query(`UPDATE v2_stock_lots l SET reserved=l.reserved-a.quantity FROM v2_stock_allocations a
    WHERE a.lot_id=l.id AND a.order_id=$1 AND a.deducted_at IS NULL`,[orderId]);
  await db.query('DELETE FROM v2_stock_allocations WHERE order_id=$1 AND deducted_at IS NULL',[orderId]);
}

export async function deductStock(db: Transaction, order: Order, user: Principal) {
  const allocations = (await db.query<{ lot_id:string; product_id:string; quantity:number }>(`SELECT a.lot_id,l.product_id,a.quantity
    FROM v2_stock_allocations a JOIN v2_stock_lots l ON l.id=a.lot_id WHERE a.order_id=$1 AND a.deducted_at IS NULL`,[order.id])).rows;
  if (!allocations.length) throw conflict('NO_RESERVATION','Aucune réservation disponible pour cette commande stock.');
  for (const item of allocations) {
    await db.query('UPDATE v2_stock_lots SET reserved=reserved-$2,physical=physical-$2 WHERE id=$1',[item.lot_id,item.quantity]);
    await db.query('INSERT INTO v2_stock_moves(product_id,order_id,lot_id,delta,kind,actor_id) VALUES($1,$2,$3,$4,\'RAMASSAGE\',$5)',
      [item.product_id,order.id,item.lot_id,-item.quantity,user.id]);
  }
  await db.query('UPDATE v2_stock_allocations SET deducted_at=now() WHERE order_id=$1 AND deducted_at IS NULL',[order.id]);
}

export async function restockReturn(db: Transaction, order: Order, damaged: boolean, user: Principal) {
  const items = (await db.query<{ product_id:string; quantity:number }>(`SELECT l.product_id,SUM(a.quantity)::int quantity
    FROM v2_stock_allocations a JOIN v2_stock_lots l ON l.id=a.lot_id
    WHERE a.order_id=$1 AND a.deducted_at IS NOT NULL GROUP BY l.product_id`,[order.id])).rows;
  if (!items.length) throw conflict('NO_DEDUCTION','Aucune sortie de stock à rapprocher pour ce colis.');
  for (const item of items) {
    const move = await one<{ id:string }>(db,`INSERT INTO v2_stock_moves(product_id,order_id,delta,kind,actor_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,[item.product_id,order.id,item.quantity,damaged?'QUARANTAINE':'RETOUR',user.id]);
    if (move && !damaged) await db.query('INSERT INTO v2_stock_lots(product_id,physical) VALUES($1,$2)',[item.product_id,item.quantity]);
  }
  if (!damaged) await reconsiderShortages(db,order.merchant_id,user);
}

export function stockRoutes(ctx: Context) {
  const { app,pool }=ctx;
  app.get('/api/v2/stock',async request => {
    const user=await ctx.user(request);
    check(user,'stock.read',ownScope(user));
    const filter=z.object({merchantId:uuid.optional()}).parse(request.query);
    if (user.merchantId && filter.merchantId && filter.merchantId!==user.merchantId) throw forbidden();
    const {rows}=await pool.query(`SELECT p.id,p.sku,p.name,p.merchant_id,m.name AS merchant,
      COALESCE(SUM(l.physical),0)::int AS physical,COALESCE(SUM(l.reserved),0)::int AS reserved,
      COALESCE(SUM(l.physical-l.reserved),0)::int AS available,
      (SELECT COALESCE(SUM(delta),0)::int FROM v2_stock_moves s WHERE s.product_id=p.id AND s.kind='QUARANTAINE') AS quarantined
      FROM v2_stock_products p JOIN v2_merchants m ON m.id=p.merchant_id LEFT JOIN v2_stock_lots l ON l.product_id=p.id
      WHERE ($1::uuid IS NULL OR p.merchant_id=$1) GROUP BY p.id,m.name ORDER BY m.name,p.sku`,[user.merchantId??filter.merchantId??null]);
    return { rows };
  });
  app.get('/api/v2/stock/products/:id/lots',async request=>{
    const user=await ctx.user(request); check(user,'stock.manage');
    const {rows}=await pool.query('SELECT id,physical,reserved,created_at FROM v2_stock_lots WHERE product_id=$1 ORDER BY created_at,id',[param(request)]);
    return {rows};
  });
  app.post('/api/v2/stock/products',async (request,reply) => {
    const user=await ctx.user(request); check(user,'stock.manage');
    const input=z.object({merchantId:uuid,sku:text(80),name:text(150)}).strict().parse(request.body);
    const product=await transaction(pool,async db=>{
      const row=await one<{id:string}>(db,'INSERT INTO v2_stock_products(merchant_id,sku,name) VALUES($1,$2,$3) RETURNING *',
        [input.merchantId,input.sku,input.name]);
      await audit(db,user,'STOCK_PRODUCT_CREATED','PRODUCT',row!.id);
      return row;
    });
    return reply.code(201).send(product);
  });
  async function changeLot(request: FastifyRequest, adjustment: boolean) {
    const user=await ctx.user(request); check(user,'stock.manage');
    const id=param(request);
    const input=z.object({ quantity:z.number().int().min(adjustment?0:1).max(100_000), reason:adjustment?text(250):text(250).optional() }).strict().parse(request.body);
    return transaction(pool,async db=>{
      const product = await one<{id:string;merchant_id:string;reserved?:number}>(db,adjustment
        ? 'SELECT p.id,p.merchant_id,l.reserved FROM v2_stock_lots l JOIN v2_stock_products p ON p.id=l.product_id WHERE l.id=$1'
        : 'SELECT id,merchant_id FROM v2_stock_products WHERE id=$1',[id]);
      if (!product) throw missing();
      await stockLock(db,product.merchant_id);
      if (!adjustment) {
        const lot=await one<{id:string}>(db,'INSERT INTO v2_stock_lots(product_id,physical) VALUES($1,$2) RETURNING id',[product.id,input.quantity]);
        await db.query("INSERT INTO v2_stock_moves(product_id,lot_id,delta,kind,actor_id) VALUES($1,$2,$3,'RECEPTION',$4)",
          [product.id,lot!.id,input.quantity,user.id]);
        await audit(db,user,'STOCK_RECEIVED','STOCK_LOT',lot!.id,{ quantity:input.quantity,reason:input.reason });
        await reconsiderShortages(db,product.merchant_id,user);
        return lot;
      }
      const lot=await one<{physical:number;reserved:number}>(db,'SELECT physical,reserved FROM v2_stock_lots WHERE id=$1 FOR UPDATE',[id]);
      if (!lot) throw missing();
      if (input.quantity < lot.reserved) {
        const orders=(await db.query<Order>(`SELECT o.* FROM v2_stock_allocations a JOIN v2_orders o ON o.id=a.order_id
          WHERE a.lot_id=$1 AND a.deducted_at IS NULL ORDER BY o.created_at,o.id FOR UPDATE OF o`,[id])).rows;
        for (const order of orders) {
          await releaseStock(db,order.id);
          await statusEvent(db,order,'MANQUE_STOCK',user,'OPERATIONS');
        }
      }
      const delta=input.quantity-lot.physical;
      if (delta) {
        await db.query('UPDATE v2_stock_lots SET physical=$2 WHERE id=$1',[id,input.quantity]);
        await db.query("INSERT INTO v2_stock_moves(product_id,lot_id,delta,kind,actor_id) VALUES($1,$2,$3,'AJUSTEMENT',$4)",[product.id,id,delta,user.id]);
        await audit(db,user,'STOCK_ADJUSTED','STOCK_LOT',id,{ delta,reason:input.reason });
        await reconsiderShortages(db,product.merchant_id,user);
      }
      return { id,quantity:input.quantity };
    });
  }
  app.post('/api/v2/stock/products/:id/replenish',request=>changeLot(request,false));
  app.post('/api/v2/stock/lots/:id/adjust',request=>changeLot(request,true));
}
