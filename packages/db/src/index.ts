import pg from 'pg';

export type { PoolClient, QueryResult } from 'pg';

let pool: pg.Pool | undefined;

export interface DbConfig {
  connectionString: string;
  max?: number;
}

export function createPool(config: DbConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    // الـworker والـapi كلاهما يتكلم مع نفس القاعدة؛ اتصال معلّق يخنق pg-boss
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/** المسبح المشترك للعملية. يُهيّأ مرة واحدة عند الإقلاع. */
export function initPool(config: DbConfig): pg.Pool {
  pool ??= createPool(config);
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('db pool not initialised — call initPool() at startup');
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const result = await getPool().query<T>(text, values as unknown[]);
  return result.rows;
}

/** صف واحد أو undefined. يرمي إذا رجع أكثر من صف — استعلام هوية يجب أن يكون هوية. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<T | undefined> {
  const rows = await query<T>(text, values);
  if (rows.length > 1) {
    throw new Error(`queryOne matched ${rows.length} rows`);
  }
  return rows[0];
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
