import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type Database = Pick<Pool, 'query'>;
export type Transaction = Pick<PoolClient, 'query'>;

export function database(connectionString: string, max = 12) {
  const pool = new Pool({
    connectionString, max, connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000, statement_timeout: 12_000,
  });
  pool.on('error', () => console.error('PostgreSQL idle connection error'));
  return pool;
}

export async function transaction<T>(pool: Pool, work: (db: Transaction) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function one<T extends QueryResultRow>(db: Database, sql: string, args: unknown[] = []) {
  return (await db.query<T>(sql, args)).rows[0];
}

export async function lock(db: Transaction, scope: string, id: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [scope + ':' + id]);
}

export async function applyMigrations(pool: Pool) {
  const migrations = new URL('../../db/', import.meta.url);
  const files = (await readdir(fileURLToPath(migrations))).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('transitflow-v2-migrations',0))");
    await client.query('CREATE TABLE IF NOT EXISTS v2_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      if (await one(client, 'SELECT 1 FROM v2_schema_migrations WHERE name=$1', [file])) continue;
      const sql = (await readFile(new URL(file, migrations), 'utf8')).replace(/^BEGIN;\s*$/m, '').replace(/\bCOMMIT;\s*$/, '');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO v2_schema_migrations(name) VALUES($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('transitflow-v2-migrations',0))").catch(() => undefined);
    client.release();
  }
}

export async function verifyRuntimeRole(db: Database) {
  const result = await one<{ ok: boolean }>(db, `SELECT
     pg_has_role(current_user,'transitflow_v2_runtime','USAGE')
     AND NOT has_schema_privilege(current_user,'public','CREATE')
     AND NOT has_table_privilege(current_user,'v2_scan_events','UPDATE,DELETE,TRUNCATE')
     AND NOT has_table_privilege(current_user,'v2_audit_events','UPDATE,DELETE,TRUNCATE')
     AND NOT has_column_privilege(current_user,'v2_return_bons','first_received_at','UPDATE')
     AND NOT has_column_privilege(current_user,'v2_agency_payment_bons','paid_at','UPDATE')
     AND NOT has_column_privilege(current_user,'v2_return_bon_lines','received_at','UPDATE')
     AND has_table_privilege(current_user,'v2_orders','SELECT') AS ok`);
  if (!result?.ok) throw new Error('Use the restricted TransitFlow V2 runtime database login');
}
