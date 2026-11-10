import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';

@Controller('health')
class HealthController {
  @Get('live')
  live() {
    return { status: 'ok', service: 'transitflow-v2-api' };
  }
}

@Module({ controllers: [HealthController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true, trustProxy: false, bodyLimit: 1024 * 1024 }),
  );
  await app.register(helmet);
  app.setGlobalPrefix('api/v2');
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3100);
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error('API startup failed', error);
  process.exitCode = 1;
});
