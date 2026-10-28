import {type Pool, type PoolClient} from 'pg'

import {type Db} from '../db/pool.ts'
import {
  type NewChallenge,
  type UserWallet,
  type WalletChallenge,
  type WalletRepository,
} from './types.ts'

type Queryable = Pick<Pool, 'query'>

type WalletRow = {
  id: string
  did: string
  chain_id: string
  wallet_address: string
  verified_at: Date
  created_at: Date
  revoked_at: Date | null
}

type ChallengeRow = {
  id: string
  did: string
  chain_id: string
  wallet_address: string
  nonce_hash: string
  message: string
  expires_at: Date
  consumed_at: Date | null
  created_at: Date
}

const toWallet = (r: WalletRow): UserWallet => ({
  id: r.id,
  did: r.did,
  chainId: Number(r.chain_id),
  address: r.wallet_address,
  verifiedAt: r.verified_at,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
})

const toChallenge = (r: ChallengeRow): WalletChallenge => ({
  id: r.id,
  did: r.did,
  chainId: Number(r.chain_id),
  address: r.wallet_address,
  nonceHash: r.nonce_hash,
  message: r.message,
  expiresAt: r.expires_at,
  consumedAt: r.consumed_at,
  createdAt: r.created_at,
})

export class PgWalletRepository implements WalletRepository {
  private readonly pool: Db | null
  private readonly q: Queryable

  constructor(db: Db | PoolClient, inTransaction = false) {
    this.pool = inTransaction ? null : (db as Db)
    this.q = db
  }

  async withTransaction<T>(
    fn: (repo: WalletRepository) => Promise<T>,
  ): Promise<T> {
    if (!this.pool) return fn(this) // already inside a transaction
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(new PgWalletRepository(client, true))
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  async findLinkByAddress(chainId: number, address: string) {
    const {rows} = await this.q.query<WalletRow>(
      `SELECT * FROM user_wallets
       WHERE chain_id = $1 AND wallet_address = $2 AND revoked_at IS NULL`,
      [chainId, address],
    )
    return rows[0] ? toWallet(rows[0]) : null
  }

  async findRecentlyReleased(chainId: number, address: string, since: Date) {
    const {rows} = await this.q.query<WalletRow>(
      `SELECT * FROM user_wallets
       WHERE chain_id = $1 AND wallet_address = $2 AND revoked_at >= $3
       ORDER BY revoked_at DESC LIMIT 1`,
      [chainId, address, since],
    )
    return rows[0] ? toWallet(rows[0]) : null
  }

  async listLinksForDid(did: string) {
    const {rows} = await this.q.query<WalletRow>(
      `SELECT * FROM user_wallets WHERE did = $1 AND revoked_at IS NULL
       ORDER BY created_at, id`,
      [did],
    )
    return rows.map(toWallet)
  }

  async getLinkById(id: string) {
    const {rows} = await this.q.query<WalletRow>(
      'SELECT * FROM user_wallets WHERE id = $1',
      [id],
    )
    return rows[0] ? toWallet(rows[0]) : null
  }

  async revokeLink(id: string, did: string, now: Date) {
    // One conditional UPDATE: only the owner can revoke, and only once.
    const {rows} = await this.q.query<WalletRow>(
      `UPDATE user_wallets SET revoked_at = $3
       WHERE id = $1 AND did = $2 AND revoked_at IS NULL
       RETURNING *`,
      [id, did, now],
    )
    return rows[0] ? toWallet(rows[0]) : null
  }

  async hasOpenPayments(chainId: number, address: string) {
    const {rows} = await this.q.query(
      `SELECT 1 FROM payment_intents
       WHERE chain_id = $1
         AND (sender_wallet_address = $2 OR recipient_wallet_address = $2)
         AND status IN ('created', 'awaiting_confirmation', 'reorged')
       LIMIT 1`,
      [chainId, address],
    )
    return rows.length > 0
  }

  async countChallengesSince(did: string, since: Date) {
    const {rows} = await this.q.query<{n: string}>(
      'SELECT count(*)::text AS n FROM wallet_challenges WHERE did = $1 AND created_at >= $2',
      [did, since],
    )
    return Number(rows[0]?.n ?? 0)
  }

  async supersedeLiveChallenges(did: string, address: string, now: Date) {
    await this.q.query(
      `UPDATE wallet_challenges SET consumed_at = $3
       WHERE did = $1 AND wallet_address = $2 AND consumed_at IS NULL`,
      [did, address, now],
    )
  }

  async insertChallenge(c: NewChallenge) {
    const {rows} = await this.q.query<ChallengeRow>(
      `INSERT INTO wallet_challenges
         (did, chain_id, wallet_address, nonce_hash, message, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        c.did,
        c.chainId,
        c.address,
        c.nonceHash,
        c.message,
        c.expiresAt,
        c.createdAt,
      ],
    )
    return toChallenge(rows[0]!)
  }

  async consumeChallenge(id: string, did: string, now: Date) {
    // A single conditional UPDATE is the atomic "use once" guard.
    const {rows} = await this.q.query<ChallengeRow>(
      `UPDATE wallet_challenges SET consumed_at = $3
       WHERE id = $1 AND did = $2 AND consumed_at IS NULL AND expires_at > $3
       RETURNING *`,
      [id, did, now],
    )
    return rows[0] ? toChallenge(rows[0]) : null
  }

  async reopenChallenge(id: string) {
    await this.q.query(
      'UPDATE wallet_challenges SET consumed_at = NULL WHERE id = $1',
      [id],
    )
  }

  async deleteExpiredChallenges(before: Date) {
    const res = await this.q.query(
      'DELETE FROM wallet_challenges WHERE expires_at < $1',
      [before],
    )
    return res.rowCount ?? 0
  }

  async insertLink(link: {
    did: string
    chainId: number
    address: string
    verifiedAt: Date
  }) {
    const inserted = await this.q.query<WalletRow>(
      `INSERT INTO user_wallets (did, chain_id, wallet_address, verified_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chain_id, wallet_address) WHERE revoked_at IS NULL DO NOTHING
       RETURNING *`,
      [link.did, link.chainId, link.address, link.verifiedAt],
    )
    if (inserted.rows[0]) {
      return {wallet: toWallet(inserted.rows[0]), created: true}
    }
    const existing = await this.findLinkByAddress(link.chainId, link.address)
    return {wallet: existing!, created: false}
  }
}
