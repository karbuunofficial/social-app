import {createHash} from 'node:crypto'

import {type Db} from './db/pool.ts'
import {AppError, badRequest, conflict, unprocessable} from './errors.ts'

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

/** A request that never completed is considered abandoned after this long. */
const IN_FLIGHT_TIMEOUT_MS = 60_000
const TTL_MS = 24 * 60 * 60 * 1000

export type IdempotentResult<T> = {status: number; body: T}

export interface IdempotencyStore {
  /**
   * Runs `fn` at most once per `(did, operation, key)`.
   *
   * - Same key and same request: the stored response is replayed.
   * - Same key, different request: 422 `idempotency_key_reuse`.
   * - Same key still running: 409 `request_in_progress`.
   * - `fn` throws: nothing is stored, so the client may retry with the same key.
   */
  run<T>(
    args: {
      did: string
      operation: string
      key: string
      request: unknown
      now?: Date
    },
    fn: () => Promise<IdempotentResult<T>>,
  ): Promise<IdempotentResult<T> & {replayed: boolean}>
}

export function assertValidKey(key: string | undefined): string {
  if (!key || !KEY_PATTERN.test(key)) {
    throw badRequest(
      'invalid_idempotency_key',
      'An Idempotency-Key header of 8 to 64 characters [A-Za-z0-9_-] is required',
    )
  }
  return key
}

/** Stable hash of the request body, independent of key order. */
export function hashRequest(value: unknown): string {
  const canonical = JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : 1,
          ),
        )
      : v,
  )
  return createHash('sha256')
    .update(canonical ?? 'null')
    .digest('hex')
}

type Row = {
  request_hash: string
  response_status: number | null
  response_body: unknown
  created_at: Date
  expires_at: Date
}

export class PgIdempotencyStore implements IdempotencyStore {
  private readonly db: Pick<Db, 'query'>

  constructor(db: Pick<Db, 'query'>) {
    this.db = db
  }

  async run<T>(
    args: {
      did: string
      operation: string
      key: string
      request: unknown
      now?: Date
    },
    fn: () => Promise<IdempotentResult<T>>,
  ): Promise<IdempotentResult<T> & {replayed: boolean}> {
    const now = args.now ?? new Date()
    const hash = hashRequest(args.request)
    const expires = new Date(now.getTime() + TTL_MS)
    const keyParams = [args.did, args.operation, args.key]

    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = await this.db.query(
        `INSERT INTO idempotency_keys (did, operation, idempotency_key, request_hash, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING 1`,
        [...keyParams, hash, now, expires],
      )
      if (inserted.rows.length === 1) {
        try {
          const result = await fn()
          await this.db.query(
            `UPDATE idempotency_keys SET response_status = $4, response_body = $5::jsonb
             WHERE did = $1 AND operation = $2 AND idempotency_key = $3`,
            [...keyParams, result.status, JSON.stringify(result.body)],
          )
          return {...result, replayed: false}
        } catch (e) {
          await this.db
            .query(
              `DELETE FROM idempotency_keys WHERE did = $1 AND operation = $2 AND idempotency_key = $3`,
              keyParams,
            )
            .catch(() => {})
          throw e
        }
      }

      const {rows} = await this.db.query<Row>(
        `SELECT request_hash, response_status, response_body, created_at, expires_at
         FROM idempotency_keys WHERE did = $1 AND operation = $2 AND idempotency_key = $3`,
        keyParams,
      )
      const row = rows[0]
      if (!row) continue // deleted in between; try to insert again
      const abandoned =
        row.response_status === null &&
        now.getTime() - row.created_at.getTime() > IN_FLIGHT_TIMEOUT_MS
      if (row.expires_at <= now || abandoned) {
        // Compare with inequality, never equality: Postgres stores
        // microseconds, JavaScript dates only milliseconds.
        await this.db.query(
          `DELETE FROM idempotency_keys
           WHERE did = $1 AND operation = $2 AND idempotency_key = $3
             AND (expires_at <= $4 OR (response_status IS NULL AND created_at <= $5))`,
          [...keyParams, now, new Date(now.getTime() - IN_FLIGHT_TIMEOUT_MS)],
        )
        continue
      }
      if (row.request_hash !== hash) {
        throw unprocessable(
          'idempotency_key_reuse',
          'This Idempotency-Key was already used with a different request',
        )
      }
      if (row.response_status === null) {
        throw conflict(
          'request_in_progress',
          'A request with this Idempotency-Key is still being processed',
        )
      }
      return {
        status: row.response_status,
        body: row.response_body as T,
        replayed: true,
      }
    }
    throw new AppError(409, 'request_in_progress', 'Please retry this request')
  }
}

/** In-memory implementation with the same semantics, for tests. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<
    string,
    {hash: string; result?: IdempotentResult<unknown>}
  >()

  async run<T>(
    args: {
      did: string
      operation: string
      key: string
      request: unknown
      now?: Date
    },
    fn: () => Promise<IdempotentResult<T>>,
  ): Promise<IdempotentResult<T> & {replayed: boolean}> {
    const id = `${args.did}|${args.operation}|${args.key}`
    const hash = hashRequest(args.request)
    const row = this.rows.get(id)
    if (row) {
      if (row.hash !== hash) {
        throw unprocessable('idempotency_key_reuse', 'Idempotency-Key reused')
      }
      if (!row.result) throw conflict('request_in_progress', 'In progress')
      return {...(row.result as IdempotentResult<T>), replayed: true}
    }
    this.rows.set(id, {hash})
    try {
      const result = await fn()
      this.rows.set(id, {hash, result})
      return {...result, replayed: false}
    } catch (e) {
      this.rows.delete(id)
      throw e
    }
  }
}
