import pg from 'pg';
import { config } from '../lib/config.js';

// money is bigint minor units: parse to Number so JSON never carries "12345".
// Values stay far below 2^53 for any real bill.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  idleTimeoutMillis: 30_000,
  application_name: 'globie-keeper-api',
});

pool.on('error', (error) => {
  console.error('[db] idle client error', error);
});

/** Minimal query surface shared by the pool and a transaction client. */
export type Db = {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
};

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
