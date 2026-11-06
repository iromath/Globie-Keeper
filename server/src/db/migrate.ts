import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ??
  fileURLToPath(new URL('../../../db/migrations', import.meta.url));

/**
 * Applies every *.sql file in db/migrations once, in filename order.
 * Each file runs in its own transaction; the ledger row is written last so a
 * failed migration is retried on the next boot.
 */
export async function runMigrations(options: { silent?: boolean } = {}): Promise<string[]> {
  const log = options.silent ? () => undefined : console.log;

  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ name: string }>('select name from schema_migrations');
  const applied = new Set(rows.map((row) => row.name));
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      ran.push(file);
      log(`[db] applied ${file}`);
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }

  if (ran.length === 0) log('[db] schema up to date');
  return ran;
}
