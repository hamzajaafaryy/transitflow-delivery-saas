import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a,b);

export async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const hash = await derive(password,salt,64) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}

export async function checkPassword(password: string, record: string) {
  const valid = /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/.test(record);
  const [,salt,expected] = valid ? record.split(':') : ['','0'.repeat(32),'0'.repeat(128)];
  const actual = await derive(password,salt,64) as Buffer;
  return safeEqual(actual,Buffer.from(expected,'hex')) && valid;
}

export function seal(plaintext: string, key: Buffer, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url');
}

export function unseal(box: string, key: Buffer, context: string) {
  const data = Buffer.from(box,'base64url');
  const cipher = createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(data.subarray(12,28));
  return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');
}

function decode32(value: string) {
  if (!/^[A-Z2-7]{32,128}$/.test(value)) throw new Error('Invalid TOTP seed');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    buffer = (buffer << 5) | base32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}

export function totpAt(seed: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1',decode32(seed)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6,'0');
}

export function verifyTotp(seed: string, supplied: string, lastStep: number, now = Date.now()) {
  const step = Math.floor(now / 30_000);
  for (const candidate of [step,step - 1,step + 1]) {
    if (candidate > lastStep && safeEqual(Buffer.from(totpAt(seed,candidate)),Buffer.from(supplied))) return candidate;
  }
  return null;
}
