import { applyMigrations, database } from '../dist/db.js';

if (!process.env.TF_MIGRATION_DATABASE_URL) throw new Error('TF_MIGRATION_DATABASE_URL is required');
const pool = database(process.env.TF_MIGRATION_DATABASE_URL);
try {
  await applyMigrations(pool);
  console.log('Migrations TransitFlow V2 appliquées.');
} finally {
  await pool.end();
}
