import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { agencyReturnRoutes } from './agency-returns.js';
import { claimRoutes, monitorClaims, rebalanceClaims } from './claims.js';
import { configuration, trustedBrowserOrigin, type Config } from './config.js';
import { database, lock, transaction, verifyRuntimeRole } from './db.js';
import { dispatchRoutes } from './dispatch.js';
import { financeRoutes } from './finance.js';
import { ApiError, errorReply } from './http.js';
import { merchantReturnRoutes } from './merchant-returns.js';
import { notificationRoutes } from './notifications.js';
import { orderRoutes } from './orders.js';
import { flagStalePartners, partnerRoutes } from './partner.js';
import { pickupRoutes } from './pickups.js';
import { sessions } from './security/session.js';
import { settingsRoutes } from './settings.js';
import { stockRoutes } from './stock.js';

@Controller('health')
class HealthController {
  @Get('live')
  live() {
    return { status:'ok',service:'transitflow-v2-api' };
  }
}
@Module({ controllers:[HealthController] })
class AppModule {}

export async function createApp(config:Config) {
  const pool=database(config.databaseUrl);
  try {
    await verifyRuntimeRole(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const adapter=new FastifyAdapter({ logger:false,trustProxy:false,bodyLimit:256*1024,requestTimeout:15_000 });
  const app=await NestFactory.create<NestFastifyApplication>(AppModule,adapter,{logger:false,abortOnError:false});
  const fastify=adapter.getInstance();
  const claimSignals=new EventEmitter();
  claimSignals.setMaxListeners(0);
  const listener=await pool.connect();
  listener.on('notification',message=>{
    if (message.channel==='transitflow_claims' && message.payload) claimSignals.emit(message.payload);
  });
  listener.on('error',()=>console.error('TransitFlow claim signal connection interrupted'));
  await listener.query('LISTEN transitflow_claims');

  fastify.register(helmet,{ contentSecurityPolicy:false,strictTransportSecurity:config.secure });
  fastify.register(rateLimit,{ max:3000,timeWindow:'1 minute' });
  fastify.register(multipart,{ limits:{fileSize:3_000_000,files:1,parts:1} });
  fastify.register(async api=>{
    api.setErrorHandler((error,_request,reply)=>errorReply(error,reply));
    api.addHook('onRequest',async (request,reply)=>{
      reply.header('Cache-Control','private, no-store').header('X-Robots-Tag','noindex, nofollow');
      if (['GET','HEAD','OPTIONS'].includes(request.method) || /^\/api\/v2\/partner\/[\da-f-]+\/events$/.test(request.url.split('?')[0])) return;
      if (request.headers['x-transitflow-request']!=='1' || !trustedBrowserOrigin(config.origin,request.headers.origin,request.headers['x-transitflow-origin'],request.headers['sec-fetch-site'])) {
        throw new ApiError(403,'ORIGIN_FORBIDDEN','Origine de requête non autorisée.');
      }
    });
    const ctx=sessions(api,pool,config);
    api.get('/api/v2/health/ready',async (_request,reply)=>{
      try {
        await pool.query('SELECT 1');
        return { status:'ready' };
      } catch {
        return reply.code(503).send({status:'unavailable'});
      }
    });
    orderRoutes(ctx);
    stockRoutes(ctx);
    pickupRoutes(ctx);
    dispatchRoutes(ctx);
    agencyReturnRoutes(ctx);
    merchantReturnRoutes(ctx);
    financeRoutes(ctx);
    partnerRoutes(ctx);
    claimRoutes(ctx,claimSignals);
    notificationRoutes(ctx);
    settingsRoutes(ctx,rebalanceClaims);
    api.get('/api/v2/developer/audit',async request=>{
      const user=await ctx.user(request);
      if (user.role!=='DEVELOPER') throw new ApiError(403,'FORBIDDEN','Accès développeur requis.');
      const { rows }=await pool.query(`SELECT id,action,entity_type,entity_id,created_at,actor_id,agency_actor_id
        FROM v2_audit_events ORDER BY created_at DESC,id LIMIT 100`);
      return { rows };
    });
  });
  const timer=setInterval(()=>{
    transaction(pool,async db=>{
      await lock(db,'system','maintenance');
      await monitorClaims(db);
      await flagStalePartners(db);
      await db.query('DELETE FROM v2_sessions WHERE expires_at<now()');
      await db.query('DELETE FROM v2_login_limits WHERE reset_at<now()');
    }).catch(()=>console.error('TransitFlow maintenance failed'));
  },60_000);
  timer.unref();
  fastify.addHook('onClose',async ()=>{
    clearInterval(timer);
    listener.release(true);
    await pool.end();
  });
  app.setGlobalPrefix('api/v2');
  await app.init();
  await fastify.ready();
  return app;
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const config=configuration();
    const app=await createApp(config);
    app.enableShutdownHooks();
    await app.listen(config.port,config.host);
    console.log(`TransitFlow V2 API listening on port ${config.port}`);
  } catch (error) {
    console.error('TransitFlow V2 API startup failed', { type:error instanceof Error?error.name:'Unknown' });
    process.exitCode=1;
  }
}
