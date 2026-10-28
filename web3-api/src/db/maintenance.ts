import {type Db} from './pool.ts'

export type MaintenanceResult = {
  challenges: number
  idempotencyKeys: number
  auditEvents: number
}

/**
 * Housekeeping, safe to run repeatedly and from several instances.
 *
 * - Wallet challenges are deleted an hour after they expire (they are useless
 *   once expired; the delay keeps recent rows for debugging).
 * - Expired idempotency keys are deleted.
 * - Audit events past their retention period are deleted. Audit rows hold DIDs
 *   and wallet addresses, so they are not kept indefinitely.
 */
export async function runMaintenance(
  db: Pick<Db, 'query'>,
  now: Date,
  opts: {auditRetentionDays: number},
): Promise<MaintenanceResult> {
  const challenges = await db.query(
    `DELETE FROM wallet_challenges WHERE expires_at < $1`,
    [new Date(now.getTime() - 3_600_000)],
  )
  const keys = await db.query(
    `DELETE FROM idempotency_keys WHERE expires_at < $1`,
    [now],
  )
  const audit = await db.query(
    `DELETE FROM audit_events WHERE occurred_at < $1`,
    [new Date(now.getTime() - opts.auditRetentionDays * 86_400_000)],
  )
  return {
    challenges: challenges.rowCount ?? 0,
    idempotencyKeys: keys.rowCount ?? 0,
    auditEvents: audit.rowCount ?? 0,
  }
}
