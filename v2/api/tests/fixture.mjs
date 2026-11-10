import { randomBytes } from 'node:crypto';
import { applyMigrations, database, one, transaction } from '../dist/db.js';
import { provisionAccount } from '../dist/settings.js';

export async function fixture(ownerUrl) {
  const url=new URL(ownerUrl);
  if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('Tests require isolated loopback PostgreSQL');
  const suffix=randomBytes(6).toString('hex');
  const dbName='tf_test_'+suffix, runtimeName='tf_runtime_'+suffix;
  const owner=database(ownerUrl);
  const password=randomBytes(24).toString('hex');
  const runtimePassword=randomBytes(24).toString('hex');
  const dataKey=randomBytes(32);
  const seed=Array.from(randomBytes(32),byte=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[byte%32]).join('');
  await owner.query(`CREATE DATABASE ${dbName}`);
  const isolated=new URL(url);
  isolated.pathname='/'+dbName;
  const db=database(isolated.href);
  try {
    await applyMigrations(db);
    await applyMigrations(db);
    await owner.query(`CREATE ROLE ${runtimeName} LOGIN PASSWORD '${runtimePassword}'`);
    await owner.query(`GRANT transitflow_v2_runtime TO ${runtimeName}`);
    const runtime=new URL(isolated);
    runtime.username=runtimeName;
    runtime.password=runtimePassword;
    const agencies=(await db.query(`INSERT INTO v2_agencies(name,city) VALUES
      ('Atlas Tanger','tanger'),('Rif Tanger','tanger') RETURNING id,name`)).rows;
    const merchants=(await db.query(`INSERT INTO v2_merchants(name,phone,refused_fee_centimes) VALUES
      ('Maison Atlas','0600000001',700),('Marché Rif','0600000002',0) RETURNING id,name`)).rows;
    await db.query('INSERT INTO v2_merchant_rates VALUES($1,\'tanger\',2500)',[merchants[0].id]);
    await db.query("INSERT INTO v2_packaging_rates VALUES($1,'SACHET_PETIT',300)",[merchants[0].id]);
    const definitions={
      admin:{role:'ADMIN',totpSeed:seed},
      dev:{role:'DEVELOPER',totpSeed:seed},
      staff:{role:'EMPLOYEE',grants:['orders.read','orders.create','orders.status_override','orders.export','returns.manage',
        'dispatch.manage','stock.manage','stock.read','agency_payments.read','agency_payments.create','pickups.manage','claims.manage']},
      retour:{role:'EMPLOYEE',grants:['returns.manage']},
      collector:{role:'EMPLOYEE',grants:['pickups.collect'],zone:'tanger'},
      finance:{role:'RESPONSABLE',grants:['agency_payments.confirm_paid'],totpSeed:seed},
      agency:{role:'PARTNER_AGENCY',agencyId:agencies[0].id},
      otherAgency:{role:'PARTNER_AGENCY',agencyId:agencies[1].id},
      merchant:{role:'MERCHANT',merchantId:merchants[0].id},
      otherMerchant:{role:'MERCHANT',merchantId:merchants[1].id},
    };
    const accounts={};
    for (const [name,definition] of Object.entries(definitions)) {
      const login=name.toLowerCase()+'@transitflow.test';
      const account=await transaction(db,client=>provisionAccount(client,dataKey,{ login,name:({staff:'Équipe opérations',agency:'Atlas Tanger',merchant:'Maison Atlas',admin:'Direction'})[name]??name,password,grants:[],...definition }));
      accounts[name]={...account,login,password,seed:definition.totpSeed};
    }
    return { db,accounts,agencies,merchants,runtimeUrl:runtime.href,dataKey,
      async close() {
        await db.end();
        await owner.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
        await owner.query(`DROP ROLE ${runtimeName}`);
        await owner.end();
      },
      query: (sql,values)=>one(db,sql,values),
    };
  } catch (error) {
    await db.end();
    await owner.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await owner.query(`DROP ROLE IF EXISTS ${runtimeName}`);
    await owner.end();
    throw error;
  }
}
