import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
export function hashPassword(password){
 if (typeof password!=='string'||password.length<12||password.length>128) throw Error('Mot de passe: 12 à 128 caractères requis');
 const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
export function verifyPassword(password,record){
 if(!record||typeof password!=='string')return false;
 try{const [salt,hash]=record.split(':');const actual=scryptSync(password,salt,64);const expected=Buffer.from(hash,'hex');return expected.length===actual.length&&timingSafeEqual(actual,expected);}catch{return false;}
}
const b64 = x=>Buffer.from(JSON.stringify(x)).toString('base64url');
export function signToken(data,secret){const payload=b64({...data,exp:Date.now()+8*3600000});return `${payload}.${createHmac('sha256',secret).update(payload).digest('base64url')}`;}
export function verifyToken(token,secret){
 if(typeof token!=='string'||token.length>4000)return null;
 const parts=token.split('.');if(parts.length!==2)return null;
 const signature=createHmac('sha256',secret).update(parts[0]).digest();
 let received;try{received=Buffer.from(parts[1],'base64url');}catch{return null;}
 if(signature.length!==received.length||!timingSafeEqual(signature,received))return null;
 try{const value=JSON.parse(Buffer.from(parts[0],'base64url').toString());return Number.isFinite(value.exp)&&value.exp>Date.now()?value:null;}catch{return null;}
}
export function hashKey(key){return createHmac('sha256','api-key-v1').update(key).digest('hex');}
export const makeKey=()=>`dn_${randomBytes(32).toString('base64url')}`;
