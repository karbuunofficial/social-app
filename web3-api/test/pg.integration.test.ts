import {Pool} from 'pg'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {migrate} from '../src/db/migrate.ts'
import {PgWalletRepository} from '../src/wallet/pg-repository.ts'
import {sha256Hex, WalletLinkService} from '../src/wallet/service.ts'
import {EoaSignatureVerifier} from '../src/wallet/signature-verifier.ts'
import {ALICE, BOB, newWallet, testConfig} from './helpers/fixtures.ts'

/**
 * Runs against a real PostgreSQL. Skipped (and reported as skipped) unless
 * TEST_DATABASE_URL is set. The database is migrated down and up, so use a
 * disposable database.
 */
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('postgres schema and repositories', () => {
  let pool: Pool

  const A = '0x' + 'a'.repeat(40)
  const B = '0x' + 'b'.repeat(40)
  const HASH = '0x' + 'c'.repeat(64)

  const rejects = async (sql: string, params: unknown[], match: RegExp) => {
    await expect(pool.query(sql, params)).rejects.toThrow(match)
  }

  const intent = async (amount: string, sender = ALICE, recipient = BOB) =>
    (
      await pool.query<{id: string}>(
        `INSERT INTO payment_intents
           (sender_did, recipient_did, chain_id, token_address,
            sender_wallet_address, recipient_wallet_address, amount, expires_at)
         VALUES ($1,$2,84532,$3,$4,$5,$6, now() + interval '1 hour') RETURNING id`,
        [sender, recipient, A, A, B, amount],
      )
    ).rows[0]!.id

  beforeAll(async () => {
    pool = new Pool({connectionString: url})
    // Prove the whole history reverts and re-applies cleanly.
    for (let i = 0; i < 5; i++) await migrate(url!, 'down')
    const applied = await migrate(url!, 'up')
    expect(applied).toHaveLength(5)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('migrates down to nothing and back up', async () => {
    const tables = async () =>
      (
        await pool.query<{table_name: string}>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name <> 'pgmigrations'
           ORDER BY table_name`,
        )
      ).rows.map(r => r.table_name)

    const expected = [
      'audit_events',
      'chain_transactions',
      'creator_plans',
      'idempotency_keys',
      'payment_intents',
      'subscription_entitlements',
      'user_wallets',
      'wallet_challenges',
    ]
    expect(await tables()).toEqual(expected)
    await migrate(url!, 'down', 5)
    expect(await tables()).toEqual([])
    await migrate(url!, 'up')
    expect(await tables()).toEqual(expected)
  })

  describe('user_wallets', () => {
    const insert = (did: string, chain: number, addr: string) =>
      pool.query(
        `INSERT INTO user_wallets (did, chain_id, wallet_address, verified_at)
         VALUES ($1,$2,$3, now())`,
        [did, chain, addr],
      )

    it('validates formats', async () => {
      await rejects(
        'INSERT INTO user_wallets (did, chain_id, wallet_address, verified_at) VALUES ($1,$2,$3, now())',
        ['not-a-did', 84532, A],
        /user_wallets_did_format/,
      )
      await rejects(
        'INSERT INTO user_wallets (did, chain_id, wallet_address, verified_at) VALUES ($1,$2,$3, now())',
        [ALICE, 84532, '0x' + 'A'.repeat(40)],
        /user_wallets_address_format/,
      )
      await rejects(
        'INSERT INTO user_wallets (did, chain_id, wallet_address, verified_at) VALUES ($1,$2,$3, now())',
        [ALICE, 0, A],
        /user_wallets_chain_positive/,
      )
    })

    it('binds a wallet to one DID per chain but allows the same address on another chain', async () => {
      await insert(ALICE, 84532, A)
      await rejects(
        'INSERT INTO user_wallets (did, chain_id, wallet_address, verified_at) VALUES ($1,$2,$3, now())',
        [BOB, 84532, A],
        /user_wallets_active_chain_address_idx/,
      )
      await insert(ALICE, 8453, A)
    })

    it('frees a wallet for relinking only after it is revoked', async () => {
      const C = '0x' + 'e'.repeat(40)
      await insert(ALICE, 84532, C)
      await pool.query(
        'UPDATE user_wallets SET revoked_at = now() WHERE wallet_address = $1',
        [C],
      )
      // Revoked rows are history; a new active row is now allowed.
      await insert(BOB, 84532, C)
      const {rows} = await pool.query<{did: string; revoked_at: Date | null}>(
        'SELECT did, revoked_at FROM user_wallets WHERE wallet_address = $1 ORDER BY created_at',
        [C],
      )
      expect(rows).toHaveLength(2)
      expect(rows.filter(r => r.revoked_at === null)).toHaveLength(1)
    })

    it('cannot be revoked before it was verified', async () => {
      await rejects(
        `INSERT INTO user_wallets (did, chain_id, wallet_address, verified_at, revoked_at)
         VALUES ($1,84532,$2, now(), now() - interval '1 day')`,
        [ALICE, '0x' + 'f'.repeat(40)],
        /user_wallets_revoked_after_verified/,
      )
    })
  })

  describe('wallet_challenges', () => {
    const insert = (
      did: string,
      addr: string,
      nonce: string,
      expires = '1 hour',
    ) =>
      pool.query(
        `INSERT INTO wallet_challenges
           (did, chain_id, wallet_address, nonce_hash, message, expires_at)
         VALUES ($1,84532,$2,$3,'m', now() + $4::interval)`,
        [did, addr, nonce, expires],
      )

    it('allows only one live challenge per DID and wallet', async () => {
      await insert(ALICE, A, '1'.repeat(64))
      await rejects(
        `INSERT INTO wallet_challenges (did, chain_id, wallet_address, nonce_hash, message, expires_at)
         VALUES ($1,84532,$2,$3,'m', now() + interval '1 hour')`,
        [ALICE, A, '2'.repeat(64)],
        /wallet_challenges_one_live_idx/,
      )
      // Once consumed, a new one is allowed.
      await pool.query(
        'UPDATE wallet_challenges SET consumed_at = now() WHERE nonce_hash = $1',
        ['1'.repeat(64)],
      )
      await insert(ALICE, A, '2'.repeat(64))
    })

    it('rejects reused nonces, bad hashes and non-future expiry', async () => {
      await rejects(
        `INSERT INTO wallet_challenges (did, chain_id, wallet_address, nonce_hash, message, expires_at)
         VALUES ($1,84532,$2,$3,'m', now() + interval '1 hour')`,
        [BOB, B, '2'.repeat(64)],
        /wallet_challenges_nonce_hash_unique/,
      )
      await rejects(
        `INSERT INTO wallet_challenges (did, chain_id, wallet_address, nonce_hash, message, expires_at)
         VALUES ($1,84532,$2,'short','m', now() + interval '1 hour')`,
        [BOB, B],
        /wallet_challenges_nonce_hash_format/,
      )
      await rejects(
        `INSERT INTO wallet_challenges (did, chain_id, wallet_address, nonce_hash, message, expires_at)
         VALUES ($1,84532,$2,$3,'m', now() - interval '1 hour')`,
        [BOB, B, '3'.repeat(64)],
        /wallet_challenges_expiry_after_creation/,
      )
    })
  })

  describe('token amounts', () => {
    it('stores uint256 exactly with no floating point loss', async () => {
      const max = (2n ** 256n - 1n).toString()
      const id = await intent(max)
      const {rows} = await pool.query<{amount: string}>(
        'SELECT amount FROM payment_intents WHERE id = $1',
        [id],
      )
      // pg returns NUMERIC as a string, so BigInt is exact.
      expect(typeof rows[0]!.amount).toBe('string')
      expect(BigInt(rows[0]!.amount)).toBe(2n ** 256n - 1n)
      // Contrast: routing the same value through a JS number loses precision.
      expect(BigInt(Number(max))).not.toBe(2n ** 256n - 1n)
    })

    it('rejects zero, negative and oversized amounts', async () => {
      await expect(intent('0')).rejects.toThrow(
        /payment_intents_amount_positive/,
      )
      await expect(intent('-5')).rejects.toThrow(
        /payment_intents_amount_positive/,
      )
      await expect(intent((10n ** 78n).toString())).rejects.toThrow(
        /numeric field overflow/,
      )
    })

    it('rejects self-payment and unknown statuses', async () => {
      await expect(intent('1', ALICE, ALICE)).rejects.toThrow(
        /payment_intents_no_self_payment/,
      )
      await rejects(
        `INSERT INTO payment_intents
           (sender_did, recipient_did, chain_id, token_address, sender_wallet_address,
            recipient_wallet_address, amount, status, expires_at)
         VALUES ($1,$2,84532,$3,$3,$3,1,'paid', now())`,
        [ALICE, BOB, A],
        /payment_intents_status_valid/,
      )
    })
  })

  describe('chain_transactions', () => {
    const tx = (intentId: string | null, hash: string, status = 'pending') =>
      pool.query(
        `INSERT INTO chain_transactions (chain_id, tx_hash, payment_intent_id, status)
         VALUES (84532,$1,$2,$3)`,
        [hash, intentId, status],
      )

    it('never records the same transaction twice', async () => {
      const id = await intent('1')
      await tx(id, HASH)
      await rejects(
        `INSERT INTO chain_transactions (chain_id, tx_hash, payment_intent_id) VALUES (84532,$1,NULL)`,
        [HASH],
        /chain_transactions_chain_hash_unique/,
      )
    })

    it('allows at most one transaction per intent', async () => {
      const id = await intent('1')
      await tx(id, '0x' + '1'.repeat(64), 'confirmed')
      await rejects(
        `INSERT INTO chain_transactions (chain_id, tx_hash, payment_intent_id, status)
         VALUES (84532,$1,$2,'pending')`,
        ['0x' + '2'.repeat(64), id],
        /chain_transactions_one_per_intent_idx/,
      )
    })

    it('validates hash format', async () => {
      await rejects(
        `INSERT INTO chain_transactions (chain_id, tx_hash) VALUES (84532,'0xabc')`,
        [],
        /chain_transactions_hash_format/,
      )
    })
  })

  describe('plans and entitlements', () => {
    const plan = async (
      over: Partial<{price: string; secs: number; name: string}> = {},
    ) =>
      (
        await pool.query<{id: string}>(
          `INSERT INTO creator_plans
             (creator_did, name, chain_id, token_address, price_amount, currency, access_duration_seconds)
           VALUES ($1,$2,84532,$3,$4,'USDC',$5) RETURNING id`,
          [
            BOB,
            over.name ?? 'Gold',
            A,
            over.price ?? '5000000',
            over.secs ?? 2592000,
          ],
        )
      ).rows[0]!.id

    const grant = (planId: string, over: Record<string, unknown> = {}) =>
      pool.query(
        `INSERT INTO subscription_entitlements
           (subscriber_did, creator_did, plan_id, payment_intent_id, starts_at, expires_at, status, revoked_at)
         VALUES ($1,$2,$3,$4, now(), now() + interval '30 days', $5, $6)`,
        [
          over.subscriber ?? ALICE,
          over.creator ?? BOB,
          planId,
          over.payment ?? null,
          over.status ?? 'active',
          over.revokedAt ?? null,
        ],
      )

    it('validates plans', async () => {
      await expect(plan({price: '0'})).rejects.toThrow(
        /creator_plans_price_positive/,
      )
      await expect(plan({secs: 60})).rejects.toThrow(
        /creator_plans_duration_range/,
      )
      await expect(plan({name: ''})).rejects.toThrow(
        /creator_plans_name_length/,
      )
      await expect(plan()).resolves.toBeTruthy()
    })

    it('grants access at most once per payment', async () => {
      const planId = await plan()
      const pi = await intent('5000000')
      await grant(planId, {payment: pi})
      await rejects(
        `INSERT INTO subscription_entitlements
           (subscriber_did, creator_did, plan_id, payment_intent_id, starts_at, expires_at)
         VALUES ($1,$2,$3,$4, now(), now() + interval '1 day')`,
        [ALICE, BOB, planId, pi],
        /subscription_entitlements_payment_unique/,
      )
    })

    it('keeps revocation consistent and forbids self-subscription', async () => {
      const planId = await plan()
      await expect(grant(planId, {status: 'revoked'})).rejects.toThrow(
        /subscription_entitlements_revoked_consistent/,
      )
      await expect(grant(planId, {revokedAt: new Date()})).rejects.toThrow(
        /subscription_entitlements_revoked_consistent/,
      )
      await expect(grant(planId, {subscriber: BOB})).rejects.toThrow(
        /subscription_entitlements_not_self/,
      )
      await expect(
        grant(planId, {status: 'revoked', revokedAt: new Date()}),
      ).resolves.toBeTruthy()
    })

    it('rejects an inverted window', async () => {
      const planId = await plan()
      await rejects(
        `INSERT INTO subscription_entitlements (subscriber_did, creator_did, plan_id, starts_at, expires_at)
         VALUES ($1,$2,$3, now(), now() - interval '1 day')`,
        [ALICE, BOB, planId],
        /subscription_entitlements_window/,
      )
    })
  })

  describe('PgWalletRepository', () => {
    const makeService = () =>
      new WalletLinkService(
        new PgWalletRepository(pool),
        new EoaSignatureVerifier(),
        testConfig(),
      )

    it('links a wallet end to end with real signatures', async () => {
      const service = makeService()
      const wallet = newWallet()
      const ch = await service.createChallenge(ALICE, {
        address: wallet.address,
        chainId: 84532,
      })
      const signature = await wallet.signMessage({message: ch.message})
      const res = await service.verifyChallenge(ALICE, {
        challengeId: ch.challengeId,
        signature,
      })
      expect(res.created).toBe(true)
      expect(res.wallet.address).toBe(wallet.address)

      // Replay fails against the database too.
      await expect(
        service.verifyChallenge(ALICE, {
          challengeId: ch.challengeId,
          signature,
        }),
      ).rejects.toMatchObject({code: 'invalid_or_expired_challenge'})

      const {rows} = await pool.query<{nonce_hash: string}>(
        'SELECT nonce_hash FROM wallet_challenges WHERE id = $1',
        [ch.challengeId],
      )
      const nonce = /Nonce: (\S+)/.exec(ch.message)![1]!
      expect(rows[0]!.nonce_hash).toBe(sha256Hex(nonce))
    })

    it('consumes a challenge exactly once under concurrency', async () => {
      const repo = new PgWalletRepository(pool)
      const wallet = newWallet()
      const now = new Date()
      const c = await repo.insertChallenge({
        did: ALICE,
        chainId: 84532,
        address: wallet.address.toLowerCase(),
        nonceHash: sha256Hex(Math.random().toString()),
        message: 'm',
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
      })
      const results = await Promise.all(
        Array.from({length: 20}, () => repo.consumeChallenge(c.id, ALICE, now)),
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it('refuses to consume expired or foreign challenges', async () => {
      const repo = new PgWalletRepository(pool)
      const wallet = newWallet()
      const now = new Date()
      const c = await repo.insertChallenge({
        did: ALICE,
        chainId: 84532,
        address: wallet.address.toLowerCase(),
        nonceHash: sha256Hex(Math.random().toString()),
        message: 'm',
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
      })
      expect(await repo.consumeChallenge(c.id, BOB, now)).toBeNull()
      expect(
        await repo.consumeChallenge(
          c.id,
          ALICE,
          new Date(now.getTime() + 61_000),
        ),
      ).toBeNull()
      expect(await repo.consumeChallenge(c.id, ALICE, now)).not.toBeNull()
    })

    it('lets only one DID win a wallet when both verify concurrently', async () => {
      const service = makeService()
      const wallet = newWallet()
      const a = await service.createChallenge(ALICE, {
        address: wallet.address,
        chainId: 84532,
      })
      const b = await service.createChallenge(BOB, {
        address: wallet.address,
        chainId: 84532,
      })
      const [sa, sb] = await Promise.all([
        wallet.signMessage({message: a.message}),
        wallet.signMessage({message: b.message}),
      ])
      const settled = await Promise.allSettled([
        service.verifyChallenge(ALICE, {
          challengeId: a.challengeId,
          signature: sa,
        }),
        service.verifyChallenge(BOB, {
          challengeId: b.challengeId,
          signature: sb,
        }),
      ])
      expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      const rejected = settled.find(
        r => r.status === 'rejected',
      ) as PromiseRejectedResult
      expect(rejected.reason).toMatchObject({code: 'wallet_already_linked'})
      const {rows} = await pool.query(
        'SELECT did FROM user_wallets WHERE wallet_address = $1 AND chain_id = 84532',
        [wallet.address.toLowerCase()],
      )
      expect(rows).toHaveLength(1)
    })
  })
})
