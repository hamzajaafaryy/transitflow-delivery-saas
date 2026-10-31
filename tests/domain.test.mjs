import test from 'node:test';import assert from 'node:assert/strict';
import { canTransition,mapAgencyStatus,centimes } from '../src/domain.mjs';
import { hashPassword,verifyPassword,signToken,verifyToken } from '../src/auth.mjs';
import { xlsx,rowsToOrders,parseCsv } from '../src/excel.mjs';
test('statuts: external mapping and valid handover',()=>{
 assert.equal(mapAgencyStatus('ramassé'),'PICKED_UP');
 assert.equal(mapAgencyStatus('Livré'),'DELIVERED');
 assert.equal(canTransition('EXPORTED','PICKED_UP'),true);
 assert.equal(canTransition('DELIVERED','PICKED_UP'),false);
 assert.equal(mapAgencyStatus('UNKNOWN'),null);
});
test('money: centimes integer and invalid values',()=>{assert.equal(centimes('199.95'),19995);assert.throws(()=>centimes(-1));});
test('auth: strong password & tamper-proof session',()=>{
 const pass='strong-password-xyz';const hashed=hashPassword(pass);
 assert.ok(verifyPassword(pass,hashed));assert.equal(verifyPassword('wrong',hashed),false);
 assert.throws(()=>hashPassword('short'));
 const jwt=signToken({uid:'a',tid:'b'},'test-secret-very-long-abc');
 assert.equal(verifyToken(jwt,'test-secret-very-long-abc').uid,'a');
 assert.equal(verifyToken(jwt+'X','test-secret-very-long-abc'),null);
});
test('Excel XLSX standard library roundtrip',()=>{
 const rows=[['Tracking','Destinataire','Téléphone','Adresse','Ville','COD','Description'],['DN123456','Alice','0612345678','Rue Maroc','Agadir','199.95','Produit']];
 const bytes=xlsx('export',rows);assert.equal(bytes.slice(0,2).toString(),'PK');
 const result=xlsx('import',bytes);assert.deepEqual(result,rows);
 assert.equal(rowsToOrders(result)[0].cod,199.95);
 assert.equal(parseCsv('"Tracking","Ville"\n"A","Tanger"\n')[1][1],'Tanger');
});
