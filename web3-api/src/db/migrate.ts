import {fileURLToPath} from 'node:url'

import {runner} from 'node-pg-migrate'

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations', import.meta.url),
)

/**
 * Applies (`up`) or reverts (`down`) migrations. Migrations are plain SQL
 * files with `-- Up Migration` / `-- Down Migration` sections. Never edit a
 * migration that has been applied anywhere shared; add a new one instead.
 */
export async function migrate(
  databaseUrl: string,
  direction: 'up' | 'down',
  count = Infinity,
): Promise<string[]> {
  const applied = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    count,
    migrationsTable: 'pgmigrations',
    // Fail instead of silently skipping if history and files disagree.
    checkOrder: true,
    log: () => {},
  })
  return applied.map(m => m.name)
}
