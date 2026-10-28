import {type Db} from './db/pool.ts'

export type AuditOutcome = 'success' | 'denied' | 'failure'

/**
 * A security-relevant event. Metadata must stay small and non-sensitive: never
 * put tokens, signatures, IP addresses or raw request bodies in it.
 */
export type AuditEvent = {
  /** `domain.verb`, e.g. `wallet.link`, `wallet.unlink`, `tip.intent.create`. */
  action: string
  actorDid?: string | null
  subjectType?: string
  subjectId?: string
  outcome: AuditOutcome
  reason?: string
  requestId?: string
  metadata?: Record<string, string | number | boolean | null>
}

export interface AuditLog {
  /** Never throws: auditing must not turn a handled request into a failure. */
  record(event: AuditEvent): Promise<void>
}

type LogFn = (obj: Record<string, unknown>, msg: string) => void

/**
 * Writes to the `audit_events` table and also emits a structured log line, so
 * events survive a database outage in the log stream.
 */
export class PgAuditLog implements AuditLog {
  private readonly db: Pick<Db, 'query'>
  private readonly log: LogFn

  constructor(db: Pick<Db, 'query'>, log: LogFn) {
    this.db = db
    this.log = log
  }

  async record(e: AuditEvent): Promise<void> {
    this.log({audit: e}, 'audit event')
    try {
      await this.db.query(
        `INSERT INTO audit_events
           (actor_did, action, subject_type, subject_id, outcome, reason, request_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          e.actorDid ?? null,
          e.action,
          e.subjectType ?? null,
          e.subjectId ?? null,
          e.outcome,
          e.reason ?? null,
          e.requestId ?? null,
          JSON.stringify(e.metadata ?? {}),
        ],
      )
    } catch (err) {
      this.log({err, action: e.action}, 'failed to persist audit event')
    }
  }
}

/** In-memory log for tests and local development. */
export class MemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = []

  record(event: AuditEvent): Promise<void> {
    this.events.push(event)
    return Promise.resolve()
  }
}
