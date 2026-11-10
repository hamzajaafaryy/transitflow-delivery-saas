import { z } from 'zod';

export interface Config {
  origin: string;
  databaseUrl: string;
  dataKey: Buffer;
  host: string;
  port: number;
  secure: boolean;
}

export function configuration(env = process.env): Config {
  const input = z.object({
    TF_APP_ORIGIN: z.string().url(),
    TF_DATABASE_URL: z.string().startsWith('postgres'),
    TF_DATA_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    HOST: z.enum(['127.0.0.1','0.0.0.0']).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  }).parse(env);
  const origin = new URL(input.TF_APP_ORIGIN);
  if (origin.origin !== input.TF_APP_ORIGIN ||
      !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1','localhost'].includes(origin.hostname))) {
    throw new Error('TF_APP_ORIGIN must be a bare HTTPS origin, or HTTP on loopback');
  }
  if (origin.protocol === 'http:' && input.HOST !== '127.0.0.1') {
    throw new Error('HTTP preview must listen on loopback');
  }
  return { origin: origin.origin, databaseUrl: input.TF_DATABASE_URL, dataKey: Buffer.from(input.TF_DATA_KEY,'hex'),
    host: input.HOST, port: input.PORT, secure: origin.protocol === 'https:' };
}

export function codespacesOrigin(env:NodeJS.ProcessEnv, port:number) {
  if (env.CODESPACES!=='true' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(env.CODESPACE_NAME??'') ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN??'')) return null;
  return `https://${env.CODESPACE_NAME}-${port}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
}

export function trustedBrowserOrigin(target:string, origin:unknown, clientOrigin:unknown, fetchSite:unknown, env=process.env) {
  if (origin===target) return true;
  if (fetchSite&&fetchSite!=='same-origin' || clientOrigin!==target) return false;
  for (const port of [3200]) {
    if (codespacesOrigin(env,port)===target && ['http://127.0.0.1:','http://localhost:','http://[::1]:','https://127.0.0.1:','https://localhost:']
      .some(prefix=>origin===prefix+port)) return true;
  }
  return false;
}
