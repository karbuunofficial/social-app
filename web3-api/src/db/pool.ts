import {Pool, type PoolClient} from 'pg'

import {type Config} from '../config.ts'

/**
 * Postgres returns NUMERIC as a string, which is what we want: token amounts
 * are converted to BigInt at the edge and never pass through a JS number. The
 * default pg behaviour for NUMERIC and BIGINT (strings) is relied on and is
 * asserted by the tests.
 */
export function createPool(config: Config): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL ? {rejectUnauthorized: true} : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
}

export type Db = Pick<Pool, 'query' | 'connect'>

/**
 * Runs `fn` in a transaction, rolling back on any error.
 */
export async function withTransaction<T>(
  db: Db,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
