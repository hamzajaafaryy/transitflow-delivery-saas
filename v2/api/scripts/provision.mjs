import { readFile } from 'node:fs/promises';
import { database, transaction } from '../dist/db.js';
import { accountInput, provisionAccount } from '../dist/settings.js';

const url=process.env.TF_MIGRATION_DATABASE_URL;
const key=process.env.TF_DATA_KEY;
if (!url || !/^[0-9a-f]{64}$/i.test(key??'')) throw new Error('Configure TF_MIGRATION_DATABASE_URL and TF_DATA_KEY');
const pool=database(url);
try {
  const data=await readFile('/dev/stdin','utf8');
  const account=accountInput.parse(JSON.parse(data));
  const result=await transaction(pool,db=>provisionAccount(db,Buffer.from(key,'hex'),account));
  console.log('Compte provisionné',result.id);
} catch {
  console.error('Création de compte refusée. Vérifiez les données, le rôle et les identifiants uniques.');
  process.exitCode=1;
} finally {
  await pool.end();
}
