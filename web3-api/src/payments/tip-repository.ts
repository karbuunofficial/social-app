import {type Address, type Hex} from 'viem'

import {type Db} from '../db/pool.ts'
import {
  type AttachResult,
  type NewTip,
  type ReconcileUpdate,
  type TipRecord,
  type TipRepository,
} from './tip-types.ts'
import {type ChainTransactionStatus, type PaymentIntentStatus} from './types.ts'

type Row = {
  id: string
  sender_did: string
  recipient_did: string
  chain_id: string
  token_address: string
  sender_wallet_address: string
  recipient_wallet_address: string
  amount: string
  status: PaymentIntentStatus
  post_uri: string | null
  expires_at: Date
  created_at: Date
  check_attempts: number
  last_error: string | null
  finalized_at: Date | null
  min_block_number: string | null
  tx_id: string | null
  tx_hash: string | null
  tx_status: ChainTransactionStatus | null
  tx_block_number: string | null
  tx_block_hash: string | null
  tx_confirmations: string | null
  tx_created_at: Date | null
}

/** Joined select; the intent and its single transaction in one row. */
const SELECT = `
  SELECT pi.id, pi.sender_did, pi.recipient_did, pi.chain_id, pi.token_address,
         pi.sender_wallet_address, pi.recipient_wallet_address,
         pi.amount::text AS amount, pi.status, pi.post_uri, pi.expires_at,
         pi.created_at, pi.check_attempts, pi.last_error, pi.finalized_at,
         pi.min_block_number::text AS min_block_number,
         t.id AS tx_id, t.tx_hash, t.status AS tx_status,
         t.block_number::text AS tx_block_number, t.block_hash AS tx_block_hash,
         t.confirmations::text AS tx_confirmations, t.created_at AS tx_created_at
  FROM payment_intents pi
  LEFT JOIN chain_transactions t ON t.payment_intent_id = pi.id`

const toRecord = (r: Row): TipRecord => ({
  id: r.id,
  senderDid: r.sender_did,
  recipientDid: r.recipient_did,
  chainId: Number(r.chain_id),
  tokenAddress: r.token_address as Address,
  senderWalletAddress: r.sender_wallet_address as Address,
  recipientWalletAddress: r.recipient_wallet_address as Address,
  // NUMERIC arrives as text; BigInt keeps every digit.
  amount: BigInt(r.amount),
  status: r.status,
  postUri: r.post_uri,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  checkAttempts: r.check_attempts,
  minBlockNumber:
    r.min_block_number === null ? null : BigInt(r.min_block_number),
  lastError: r.last_error,
  finalizedAt: r.finalized_at,
  tx: r.tx_id
    ? {
        id: r.tx_id,
        hash: r.tx_hash as Hex,
        status: r.tx_status!,
        blockNumber:
          r.tx_block_number === null ? null : BigInt(r.tx_block_number),
        blockHash: r.tx_block_hash as Hex | null,
        confirmations:
          r.tx_confirmations === null ? null : BigInt(r.tx_confirmations),
        createdAt: r.tx_created_at!,
      }
    : null,
})

const UNIQUE_VIOLATION = '23505'

export class PgTipRepository implements TipRepository {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  async createIntent(i: NewTip) {
    const {rows} = await this.db.query<{id: string}>(
      `INSERT INTO payment_intents
         (sender_did, recipient_did, chain_id, token_address,
          sender_wallet_address, recipient_wallet_address, amount, post_uri,
          expires_at, created_at, updated_at, min_block_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11) RETURNING id`,
      [
        i.senderDid,
        i.recipientDid,
        i.chainId,
        i.tokenAddress.toLowerCase(),
        i.senderWalletAddress.toLowerCase(),
        i.recipientWalletAddress.toLowerCase(),
        i.amount.toString(),
        i.postUri,
        i.expiresAt,
        i.createdAt,
        i.minBlockNumber?.toString() ?? null,
      ],
    )
    return (await this.getIntent(rows[0]!.id))!
  }

  async getIntent(id: string) {
    const {rows} = await this.db.query<Row>(`${SELECT} WHERE pi.id = $1`, [id])
    return rows[0] ? toRecord(rows[0]) : null
  }

  async listIntents(did: string, role: 'sent' | 'received', limit: number) {
    const col = role === 'sent' ? 'pi.sender_did' : 'pi.recipient_did'
    const {rows} = await this.db.query<Row>(
      `${SELECT} WHERE ${col} = $1 ORDER BY pi.created_at DESC, pi.id LIMIT $2`,
      [did, limit],
    )
    return rows.map(toRecord)
  }

  async countCreatedSince(senderDid: string, since: Date) {
    const {rows} = await this.db.query<{n: string}>(
      `SELECT count(*)::text AS n FROM payment_intents
       WHERE sender_did = $1 AND created_at >= $2`,
      [senderDid, since],
    )
    return Number(rows[0]?.n ?? 0)
  }

  async attachTransaction(input: {
    intentId: string
    senderDid: string
    txHash: Hex
    now: Date
    reviveWindowMs: number
  }): Promise<AttachResult> {
    const client = await this.db.connect()
    try {
      await client.query('BEGIN')
      // Lock the intent so two submissions cannot both attach.
      const found = await client.query<{
        status: PaymentIntentStatus
        chain_id: string
        expires_at: Date
      }>(
        `SELECT status, chain_id, expires_at FROM payment_intents
         WHERE id = $1 AND sender_did = $2 FOR UPDATE`,
        [input.intentId, input.senderDid],
      )
      const intent = found.rows[0]
      if (!intent) {
        await client.query('ROLLBACK')
        return {kind: 'not_found'}
      }
      const revivable =
        intent.status === 'expired' &&
        input.now.getTime() < intent.expires_at.getTime() + input.reviveWindowMs
      if (intent.status !== 'created' && !revivable) {
        await client.query('ROLLBACK')
        return intent.status === 'awaiting_confirmation' ||
          intent.status === 'confirmed' ||
          intent.status === 'reorged' ||
          intent.status === 'failed'
          ? {kind: 'already_has_transaction'}
          : {kind: 'wrong_state', status: intent.status}
      }
      const has = await client.query(
        'SELECT 1 FROM chain_transactions WHERE payment_intent_id = $1',
        [input.intentId],
      )
      if (has.rows.length > 0) {
        await client.query('ROLLBACK')
        return {kind: 'already_has_transaction'}
      }
      try {
        await client.query(
          `INSERT INTO chain_transactions
             (chain_id, tx_hash, payment_intent_id, status, created_at, updated_at)
           VALUES ($1,$2,$3,'pending',$4,$4)`,
          [
            intent.chain_id,
            input.txHash.toLowerCase(),
            input.intentId,
            input.now,
          ],
        )
      } catch (e) {
        await client.query('ROLLBACK')
        if ((e as {code?: string}).code === UNIQUE_VIOLATION) {
          return {kind: 'duplicate_transaction'}
        }
        throw e
      }
      await client.query(
        `UPDATE payment_intents
         SET status = 'awaiting_confirmation', next_check_at = $2, check_attempts = 0,
             last_error = NULL, updated_at = $2
         WHERE id = $1`,
        [input.intentId, input.now],
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    return {kind: 'attached', tip: (await this.getIntent(input.intentId))!}
  }

  async claimDue(limit: number, now: Date, leaseMs: number) {
    const lease = new Date(now.getTime() + leaseMs)
    const {rows} = await this.db.query<{id: string}>(
      `UPDATE payment_intents SET next_check_at = $3
       WHERE id IN (
         SELECT id FROM payment_intents
         WHERE status IN ('awaiting_confirmation', 'reorged', 'confirmed')
           AND finalized_at IS NULL AND next_check_at <= $1
         ORDER BY next_check_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [now, limit, lease],
    )
    if (rows.length === 0) return []
    const {rows: full} = await this.db.query<Row>(
      `${SELECT} WHERE pi.id = ANY($1::uuid[])`,
      [rows.map(r => r.id)],
    )
    return full.map(toRecord)
  }

  async applyReconciliation(u: ReconcileUpdate) {
    const client = await this.db.connect()
    try {
      await client.query('BEGIN')
      const tx = await client.query(
        `UPDATE chain_transactions
         SET status = $3, block_number = $4, block_hash = $5, confirmations = $6,
             last_checked_at = $7, updated_at = $7,
             confirmed_at = CASE WHEN $3 = 'confirmed' THEN COALESCE(confirmed_at, $7)
                                 WHEN $3 = 'reorged' THEN NULL ELSE confirmed_at END
         WHERE id = $1 AND status = $2`,
        [
          u.txId,
          u.expectedTxStatus,
          u.txStatus,
          u.blockNumber?.toString() ?? null,
          u.blockHash,
          u.confirmations?.toString() ?? null,
          u.now,
        ],
      )
      if (tx.rowCount !== 1) {
        await client.query('ROLLBACK')
        return false
      }
      const pi = await client.query(
        `UPDATE payment_intents
         SET status = $3, next_check_at = $4, finalized_at = $5,
             check_attempts = 0, last_error = NULL, last_checked_at = $6, updated_at = $6
         WHERE id = $1 AND status = $2`,
        [
          u.intentId,
          u.expectedIntentStatus,
          u.intentStatus,
          u.nextCheckAt,
          u.finalizedAt,
          u.now,
        ],
      )
      if (pi.rowCount !== 1) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query('COMMIT')
      return true
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  async recordRpcFailure(
    intentId: string,
    kind: string,
    nextCheckAt: Date,
    now: Date,
  ) {
    await this.db.query(
      `UPDATE payment_intents
       SET check_attempts = check_attempts + 1, last_error = $2,
           next_check_at = $3, last_checked_at = $4, updated_at = $4
       WHERE id = $1`,
      [intentId, kind.slice(0, 64), nextCheckAt, now],
    )
  }

  async expireStale(now: Date, neverSeenAfterMs: number) {
    const unpaid = await this.db.query(
      `UPDATE payment_intents SET status = 'expired', updated_at = $1
       WHERE status = 'created' AND expires_at < $1`,
      [now],
    )
    const cutoff = new Date(now.getTime() - neverSeenAfterMs)
    const ghost = await this.db.query(
      `UPDATE payment_intents pi SET status = 'expired', finalized_at = $1, updated_at = $1
       WHERE pi.status = 'awaiting_confirmation' AND pi.finalized_at IS NULL
         AND EXISTS (SELECT 1 FROM chain_transactions t
                     WHERE t.payment_intent_id = pi.id AND t.block_hash IS NULL
                       AND t.status = 'pending' AND t.created_at < $2)`,
      [now, cutoff],
    )
    return (unpaid.rowCount ?? 0) + (ghost.rowCount ?? 0)
  }
}
