import {Pool} from 'pg'
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'

import {MemoryAuditLog, PgAuditLog} from '../src/audit.ts'
import {RpcError, ViemChainReader} from '../src/chain/reader.ts'
import {migrate} from '../src/db/migrate.ts'
import {PgIdempotencyStore} from '../src/idempotency.ts'
import {formatTokenAmount} from '../src/payments/amounts.ts'
import {buildChainConfigs} from '../src/payments/chains.ts'
import {Reconciler} from '../src/payments/reconciler.ts'
import {PgTipRepository} from '../src/payments/tip-repository.ts'
import {
  REVIVE_WINDOW_MS,
  TippingService,
} from '../src/payments/tipping-service.ts'
import {type VerifiedToken} from '../src/payments/token-check.ts'
import {PgWalletRepository} from '../src/wallet/pg-repository.ts'
import {WalletLinkService} from '../src/wallet/service.ts'
import {EoaSignatureVerifier} from '../src/wallet/signature-verifier.ts'
import {
  blockHash,
  MockChain,
  OTHER_TOKEN,
  receipt,
  transferLog,
  txHash,
  USDC,
} from './helpers/chain.ts'
import {ALICE, BOB, newWallet, testConfig} from './helpers/fixtures.ts'
import {findRealTransfer} from './helpers/live.ts'

/**
 * Tipping and reconciliation against a real PostgreSQL and a scripted chain.
 * Skipped unless TEST_DATABASE_URL is set. The database is migrated and its
 * data tables truncated, so use a disposable database.
 */
const url = process.env.TEST_DATABASE_URL
const CHAIN = 84532

describe.skipIf(!url)(
  'tipping, reconciliation (postgres + scripted chain)',
  () => {
    let pool: Pool
    let now: Date
    let chain: MockChain
    let tips: TippingService
    let reconciler: Reconciler
    let walletRepo: PgWalletRepository
    let tipRepo: PgTipRepository
    const audit = new MemoryAuditLog()

    const alice = newWallet() // sender
    const bob = newWallet() // recipient
    let key = 0
    const nextKey = () => `idem-key-${String(++key).padStart(6, '0')}`

    const chains = buildChainConfigs({
      ALLOWED_CHAIN_IDS: [CHAIN],
      USDC_ADDRESSES: {[CHAIN]: USDC},
    })
    const token: VerifiedToken = {
      chainId: CHAIN,
      address: USDC,
      symbol: 'USDC',
      decimals: 6,
    }
    const REQUIRED = chains.get(CHAIN)!.requiredConfirmations // 5
    const FINALITY = chains.get(CHAIN)!.finalityDepth // 15

    const advance = (ms: number) => (now = new Date(now.getTime() + ms))

    beforeAll(async () => {
      pool = new Pool({connectionString: url})
      await migrate(url!, 'up')
    })
    afterAll(async () => {
      await pool.end()
    })

    beforeEach(async () => {
      await pool.query(
        'TRUNCATE audit_events, idempotency_keys, subscription_entitlements, creator_plans, chain_transactions, payment_intents, wallet_challenges, user_wallets CASCADE',
      )
      now = new Date('2026-11-01T12:00:00Z')
      chain = new MockChain()
      audit.events.length = 0
      walletRepo = new PgWalletRepository(pool)
      tipRepo = new PgTipRepository(pool)
      const pgAudit = new PgAuditLog(pool, () => {})
      tips = new TippingService({
        repo: tipRepo,
        wallets: walletRepo,
        chains,
        tokens: new Map([[CHAIN, token]]),
        config: testConfig(),
        idempotency: new PgIdempotencyStore(pool),
        audit: pgAudit,
        now: () => now,
      })
      reconciler = new Reconciler({
        repo: tipRepo,
        reader: chain,
        chains,
        options: {pollIntervalMs: 1000, leaseMs: 30_000, maxBackoffMs: 60_000},
        audit: pgAudit,
        now: () => now,
      })
      await walletRepo.insertLink({
        did: ALICE,
        chainId: CHAIN,
        address: alice.address.toLowerCase(),
        verifiedAt: now,
      })
      await walletRepo.insertLink({
        did: BOB,
        chainId: CHAIN,
        address: bob.address.toLowerCase(),
        verifiedAt: now,
      })
    })

    const create = (over: Record<string, unknown> = {}, idem = nextKey()) =>
      tips.createIntent(
        ALICE,
        {
          recipientDid: BOB,
          chainId: CHAIN,
          amount: '1.5',
          senderAddress: alice.address,
          ...over,
        },
        idem,
      )

    /** An intent with a submitted transaction, ready to reconcile. */
    async function paid(amount = '1.5', label = 'a') {
      const {body} = await create({amount})
      const hash = txHash(label)
      await tips.submitTransaction(ALICE, {intentId: body.tip.id, txHash: hash})
      const units = BigInt(body.tip.amountUnits)
      return {id: body.tip.id, hash, units}
    }

    const good = (
      units: bigint,
      over: Partial<Parameters<typeof transferLog>[0]> = {},
    ) =>
      transferLog({
        from: alice.address,
        to: bob.address,
        amount: units,
        ...over,
      })

    const row = async (id: string) => (await tipRepo.getIntent(id))!

    describe('replayed transfers', () => {
      /** Same wiring as the suite, but intents record the chain head. */
      const withReader = () =>
        new TippingService({
          repo: tipRepo,
          wallets: walletRepo,
          chains,
          tokens: new Map([[CHAIN, token]]),
          config: testConfig(),
          idempotency: new PgIdempotencyStore(pool),
          reader: chain,
          now: () => now,
        })
      const createWith = (svc: TippingService) =>
        svc.createIntent(
          ALICE,
          {
            recipientDid: BOB,
            chainId: CHAIN,
            amount: '1.5',
            senderAddress: alice.address,
          },
          nextKey(),
        )

      it('fails a matching transfer that was mined before the intent existed', async () => {
        const svc = withReader()
        chain.head = 1000n
        const {body} = await createWith(svc)
        expect((await row(body.tip.id)).minBlockNumber).toBe(1000n)
        const hash = txHash('old')
        await svc.submitTransaction(ALICE, {
          intentId: body.tip.id,
          txHash: hash,
        })
        // A perfectly matching transfer, but from block 990 (before the intent).
        chain.set(
          hash,
          receipt({
            block: 990n,
            hash: blockHash('O'),
            logs: [good(BigInt(body.tip.amountUnits))],
          }),
        )
        chain.head = 1010n
        expect(await reconciler.runOnce()).toMatchObject({failed: 1})
        const r = await row(body.tip.id)
        expect(r.status).toBe('failed')
        expect(r.tx!.status).toBe('failed')
      })

      it('confirms a matching transfer mined after the intent', async () => {
        const svc = withReader()
        chain.head = 1000n
        const {body} = await createWith(svc)
        const hash = txHash('new')
        await svc.submitTransaction(ALICE, {
          intentId: body.tip.id,
          txHash: hash,
        })
        chain.set(
          hash,
          receipt({
            block: 1001n,
            hash: blockHash('N'),
            logs: [good(BigInt(body.tip.amountUnits))],
          }),
        )
        chain.head = 1010n
        expect(await reconciler.runOnce()).toMatchObject({confirmed: 1})
        expect((await row(body.tip.id)).status).toBe('confirmed')
      })

      it('refuses to create an intent when the head cannot be read', async () => {
        const svc = withReader()
        chain.failNext = [new RpcError('timeout', 'x')]
        await expect(createWith(svc)).rejects.toMatchObject({
          code: 'chain_unavailable',
          statusCode: 503,
        })
        const {rows} = await pool.query('SELECT 1 FROM payment_intents')
        expect(rows).toHaveLength(0)
      })
    })

    describe('creating payment intents', () => {
      it('creates an intent with exact integer units and an unsigned transfer', async () => {
        const {status, body} = await create({amount: '1.5'})
        expect(status).toBe(201)
        expect(body.tip).toMatchObject({
          status: 'created',
          amountUnits: '1500000',
          amount: '1.5',
          chainId: CHAIN,
        })
        expect(body.tip.recipientAddress).toBe(bob.address)
        expect(body.tip.token).toEqual({
          address: USDC,
          symbol: 'USDC',
          decimals: 6,
        })
        expect(body.transfer).toMatchObject({
          chainId: CHAIN,
          to: USDC,
          value: '0',
        })
        expect(body.transfer.data.startsWith('0xa9059cbb')).toBe(true)
        expect(BigInt(`0x${body.transfer.data.slice(-64)}`)).toBe(1_500_000n)
        // Nothing is paid by creating an intent.
        expect(body.tip.transaction).toBeNull()
      })

      it.each([
        '0',
        '-1',
        '1e3',
        '0.0000001',
        'abc',
        '',
        ' 1',
        '1.',
        '.5',
        '0x10',
      ])('rejects amount %j', async amount => {
        await expect(create({amount})).rejects.toMatchObject({
          code: expect.stringMatching(/invalid_amount|amount_too_small/),
        })
      })

      it('enforces the configured minimum and maximum', async () => {
        await expect(create({amount: '0.009999'})).rejects.toMatchObject({
          code: 'amount_too_small',
        })
        await expect(create({amount: '0.01'})).resolves.toBeTruthy()
        await expect(create({amount: '100.000001'})).rejects.toMatchObject({
          code: 'amount_too_large',
        })
        await expect(create({amount: '100'})).resolves.toBeTruthy()
      })

      it('refuses to tip yourself', async () => {
        await expect(create({recipientDid: ALICE})).rejects.toMatchObject({
          code: 'cannot_tip_self',
        })
      })

      it('refuses a network without a verified token (wrong network, mainnet)', async () => {
        await expect(create({chainId: 8453})).rejects.toMatchObject({
          code: 'tipping_unavailable',
        })
        await expect(create({chainId: 1})).rejects.toMatchObject({
          code: 'tipping_unavailable',
        })
      })

      it('requires the paying wallet to be linked to the sender on that chain', async () => {
        await expect(
          create({senderAddress: newWallet().address}),
        ).rejects.toMatchObject({code: 'sender_wallet_not_linked'})
        // Linked to someone else is not enough.
        await expect(
          create({senderAddress: bob.address}),
        ).rejects.toMatchObject({code: 'sender_wallet_not_linked'})
      })

      it('requires a verified recipient wallet', async () => {
        const nobody = 'did:plc:nobody0000000000000000'
        await expect(create({recipientDid: nobody})).rejects.toMatchObject({
          code: 'recipient_not_tippable',
        })
        const info = await tips.getRecipient(nobody, CHAIN)
        expect(info).toEqual({
          tippable: false,
          reason: 'recipient_has_no_verified_wallet',
        })
        expect(await tips.getRecipient(BOB, CHAIN)).toMatchObject({
          tippable: true,
          recipientAddress: bob.address,
        })
        expect(await tips.getRecipient(BOB, 8453)).toEqual({
          tippable: false,
          reason: 'tipping_unavailable',
        })
      })

      it('stops paying a recipient that unlinked their wallet', async () => {
        const links = await walletRepo.listLinksForDid(BOB)
        await walletRepo.revokeLink(links[0]!.id, BOB, now)
        await expect(create()).rejects.toMatchObject({
          code: 'recipient_not_tippable',
        })
      })

      it('only accepts a post that belongs to the recipient', async () => {
        await expect(
          create({postUri: `at://${ALICE}/app.bsky.feed.post/3kabc`}),
        ).rejects.toMatchObject({code: 'invalid_post_uri'})
        await expect(
          create({postUri: 'https://evil.example/x'}),
        ).rejects.toMatchObject({code: 'invalid_post_uri'})
        const ok = await create({
          postUri: `at://${BOB}/app.bsky.feed.post/3kabc`,
        })
        expect(ok.body.tip.postUri).toBe(`at://${BOB}/app.bsky.feed.post/3kabc`)
      })

      it('limits intents per hour from the database', async () => {
        const limited = new TippingService({
          repo: tipRepo,
          wallets: walletRepo,
          chains,
          tokens: new Map([[CHAIN, token]]),
          config: {...testConfig(), TIP_INTENTS_PER_HOUR: 2},
          idempotency: new PgIdempotencyStore(pool),
          now: () => now,
        })
        const mk = () =>
          limited.createIntent(
            ALICE,
            {
              recipientDid: BOB,
              chainId: CHAIN,
              amount: '1',
              senderAddress: alice.address,
            },
            nextKey(),
          )
        await mk()
        await mk()
        await expect(mk()).rejects.toMatchObject({
          code: 'rate_limited',
          statusCode: 429,
        })
      })

      it('lets only the two parties see an intent', async () => {
        const {body} = await create()
        await expect(tips.getIntent(ALICE, body.tip.id)).resolves.toBeTruthy()
        await expect(tips.getIntent(BOB, body.tip.id)).resolves.toBeTruthy()
        await expect(
          tips.getIntent('did:plc:stranger000000000000000', body.tip.id),
        ).rejects.toMatchObject({code: 'intent_not_found'})
        await expect(tips.getIntent(ALICE, 'not-a-uuid')).rejects.toMatchObject(
          {code: 'intent_not_found'},
        )
      })
    })

    describe('idempotency', () => {
      it('creates one intent for repeated requests with the same key', async () => {
        const k = nextKey()
        const a = await create({}, k)
        const b = await create({}, k)
        expect(b.replayed).toBe(true)
        expect(b.body.tip.id).toBe(a.body.tip.id)
        const {rows} = await pool.query<{n: number}>(
          'SELECT count(*)::int AS n FROM payment_intents',
        )
        expect(rows[0]!.n).toBe(1)
      })

      it('creates exactly one intent when the same request races', async () => {
        const k = nextKey()
        const results = await Promise.allSettled(
          Array.from({length: 6}, () => create({}, k)),
        )
        const ok = results.filter(r => r.status === 'fulfilled')
        expect(ok.length).toBeGreaterThanOrEqual(1)
        for (const r of results) {
          if (r.status === 'rejected')
            expect(r.reason).toMatchObject({code: 'request_in_progress'})
        }
        const {rows} = await pool.query<{n: number}>(
          'SELECT count(*)::int AS n FROM payment_intents',
        )
        expect(rows[0]!.n).toBe(1)
      })

      it('rejects a reused key with a different body, and a missing key', async () => {
        const k = nextKey()
        await create({amount: '1'}, k)
        await expect(create({amount: '2'}, k)).rejects.toMatchObject({
          code: 'idempotency_key_reuse',
        })
        await expect(
          tips.createIntent(
            ALICE,
            {
              recipientDid: BOB,
              chainId: CHAIN,
              amount: '1',
              senderAddress: alice.address,
            },
            undefined,
          ),
        ).rejects.toMatchObject({code: 'invalid_idempotency_key'})
      })

      it('does not burn the key when validation fails', async () => {
        const k = nextKey()
        await expect(create({amount: '0'}, k)).rejects.toMatchObject({
          code: 'invalid_amount',
        })
        await expect(create({amount: '1'}, k)).resolves.toMatchObject({
          status: 201,
        })
      })

      it('takes over a request that was abandoned mid-flight (crash recovery)', async () => {
        const k = nextKey()
        // A row left behind by a crashed process: no response, created long ago.
        await pool.query(
          `INSERT INTO idempotency_keys (did, operation, idempotency_key, request_hash, created_at, expires_at)
         VALUES ($1,'tip.createIntent',$2,$3, $4, $5)`,
          [
            ALICE,
            k,
            'a'.repeat(64),
            new Date(now.getTime() - 5 * 60_000 - 123),
            new Date(now.getTime() + 86_400_000),
          ],
        )
        await expect(create({}, k)).resolves.toMatchObject({
          status: 201,
          replayed: false,
        })
      })

      it('does NOT take over a request that is genuinely still running', async () => {
        const k = nextKey()
        await pool.query(
          `INSERT INTO idempotency_keys (did, operation, idempotency_key, request_hash, created_at, expires_at)
         VALUES ($1,'tip.createIntent',$2,$3, $4, $5)`,
          [
            ALICE,
            k,
            'a'.repeat(64),
            new Date(now.getTime() - 5_000),
            new Date(now.getTime() + 86_400_000),
          ],
        )
        // Different body than the stored hash: refused rather than overwritten.
        await expect(create({}, k)).rejects.toMatchObject({
          code: 'idempotency_key_reuse',
        })
      })
    })

    describe('submitting transactions', () => {
      it('attaches a hash but does NOT mark the payment paid', async () => {
        const {body} = await create()
        const tip = await tips.submitTransaction(ALICE, {
          intentId: body.tip.id,
          txHash: txHash('x'),
        })
        expect(tip.status).toBe('awaiting_confirmation')
        expect(tip.transaction).toMatchObject({
          status: 'pending',
          blockNumber: null,
          hash: txHash('x'),
        })
        expect(tip.transaction?.explorerUrl).toBe(
          `https://sepolia.basescan.org/tx/${txHash('x')}`,
        )
      })

      it("validates the hash, and hides other people's intents", async () => {
        const {body} = await create()
        await expect(
          tips.submitTransaction(ALICE, {
            intentId: body.tip.id,
            txHash: '0x123',
          }),
        ).rejects.toMatchObject({code: 'invalid_tx_hash'})
        await expect(
          tips.submitTransaction(BOB, {
            intentId: body.tip.id,
            txHash: txHash('x'),
          }),
        ).rejects.toMatchObject({code: 'intent_not_found'})
      })

      it('prevents a duplicate transaction across payments', async () => {
        const a = await create()
        const b = await create()
        await tips.submitTransaction(ALICE, {
          intentId: a.body.tip.id,
          txHash: txHash('dup'),
        })
        await expect(
          tips.submitTransaction(ALICE, {
            intentId: b.body.tip.id,
            txHash: txHash('dup'),
          }),
        ).rejects.toMatchObject({code: 'duplicate_transaction'})
        // Case does not matter.
        await expect(
          tips.submitTransaction(ALICE, {
            intentId: b.body.tip.id,
            txHash: txHash('dup').toUpperCase().replace('0X', '0x'),
          }),
        ).rejects.toMatchObject({code: 'duplicate_transaction'})
        expect((await tipRepo.getIntent(b.body.tip.id))!.status).toBe('created')
      })

      it('allows only one transaction per payment, even from concurrent submissions', async () => {
        const {body} = await create()
        const results = await Promise.allSettled([
          tips.submitTransaction(ALICE, {
            intentId: body.tip.id,
            txHash: txHash('1'),
          }),
          tips.submitTransaction(ALICE, {
            intentId: body.tip.id,
            txHash: txHash('2'),
          }),
          tips.submitTransaction(ALICE, {
            intentId: body.tip.id,
            txHash: txHash('3'),
          }),
        ])
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
        const {rows} = await pool.query<{n: number}>(
          'SELECT count(*)::int AS n FROM chain_transactions',
        )
        expect(rows[0]!.n).toBe(1)
      })

      it('revives an expired intent within the grace window, but not after it', async () => {
        const early = await create()
        const late = await create()
        advance(3600 * 1000 + 1) // past the 1h intent TTL
        await reconciler.runOnce() // marks both expired
        expect((await tipRepo.getIntent(early.body.tip.id))!.status).toBe(
          'expired',
        )
        await expect(
          tips.submitTransaction(ALICE, {
            intentId: early.body.tip.id,
            txHash: txHash('early'),
          }),
        ).resolves.toMatchObject({status: 'awaiting_confirmation'})
        advance(REVIVE_WINDOW_MS + 1)
        await reconciler.runOnce()
        await expect(
          tips.submitTransaction(ALICE, {
            intentId: late.body.tip.id,
            txHash: txHash('late'),
          }),
        ).rejects.toMatchObject({code: 'wrong_state'})
      })
    })

    describe('reconciliation', () => {
      it('confirms a correct payment only after enough confirmations, and records block data', async () => {
        const p = await paid()
        chain.set(
          p.hash,
          receipt({block: 990n, hash: blockHash('A'), logs: [good(p.units)]}),
        )

        chain.head = 990n + BigInt(REQUIRED) - 2n // 4 confirmations: not enough yet
        expect(await reconciler.runOnce()).toMatchObject({
          checked: 1,
          pending: 1,
          confirmed: 0,
        })
        let r = await row(p.id)
        expect(r.status).toBe('awaiting_confirmation')
        expect(r.tx).toMatchObject({
          status: 'pending',
          blockNumber: 990n,
          blockHash: blockHash('A'),
        })

        advance(1500)
        chain.head = 990n + BigInt(REQUIRED) - 1n // 5 confirmations
        expect(await reconciler.runOnce()).toMatchObject({confirmed: 1})
        r = await row(p.id)
        expect(r.status).toBe('confirmed')
        expect(r.tx).toMatchObject({
          status: 'confirmed',
          blockNumber: 990n,
          blockHash: blockHash('A'),
          confirmations: BigInt(REQUIRED),
        })
        expect(audit.events).toBeDefined()
      })

      it.each([
        ['incorrect token', (u: bigint) => good(u, {token: OTHER_TOKEN})],
        [
          'incorrect recipient',
          (u: bigint) => good(u, {to: newWallet().address}),
        ],
        [
          'incorrect sender',
          (u: bigint) => good(u, {from: newWallet().address}),
        ],
        ['underpayment', (u: bigint) => good(u - 1n)],
        ['overpayment', (u: bigint) => good(u + 1n)],
      ])('fails a payment with %s', async (_name, build) => {
        const p = await paid()
        chain.set(
          p.hash,
          receipt({block: 900n, hash: blockHash('B'), logs: [build(p.units)]}),
        )
        chain.head = 2000n
        expect(await reconciler.runOnce()).toMatchObject({
          failed: 1,
          confirmed: 0,
        })
        const r = await row(p.id)
        expect(r.status).toBe('failed')
        expect(r.tx!.status).toBe('failed')
        expect(r.finalizedAt).not.toBeNull()
        // A failed payment is final and never polled again.
        const calls = chain.receiptCalls
        advance(60_000)
        await reconciler.runOnce()
        expect(chain.receiptCalls).toBe(calls)
      })

      it('fails a reverted transaction and a successful one with no transfer at all', async () => {
        const a = await paid('1', 'rev')
        const b = await paid('1', 'none')
        chain.set(
          a.hash,
          receipt({
            block: 900n,
            hash: blockHash('R'),
            logs: [good(a.units)],
            status: 'reverted',
          }),
        )
        chain.set(
          b.hash,
          receipt({block: 901n, hash: blockHash('N'), logs: []}),
        )
        chain.head = 2000n
        expect(await reconciler.runOnce()).toMatchObject({failed: 2})
      })

      it('never counts one on-chain transfer twice (two intents, one transaction)', async () => {
        const a = await paid('1.5', 'once')
        const second = await create({amount: '1.5'})
        await expect(
          tips.submitTransaction(ALICE, {
            intentId: second.body.tip.id,
            txHash: a.hash,
          }),
        ).rejects.toMatchObject({code: 'duplicate_transaction'})
      })

      it('stays pending while the node does not know the transaction, then expires it', async () => {
        const p = await paid()
        expect(await reconciler.runOnce()).toMatchObject({pending: 1})
        expect((await row(p.id)).status).toBe('awaiting_confirmation')
        advance(6 * 3_600_000 + 1000)
        const summary = await reconciler.runOnce()
        expect(summary.expired).toBe(1)
        expect((await row(p.id)).status).toBe('expired')
      })

      it('detects a reorg when the block hash changes, then recovers', async () => {
        const p = await paid()
        chain.set(
          p.hash,
          receipt({block: 900n, hash: blockHash('A'), logs: [good(p.units)]}),
        )
        // Confirmed (6 >= 5) but not final (< 15 confirmations): still reorg-able.
        chain.head = 905n
        await reconciler.runOnce()
        expect((await row(p.id)).status).toBe('confirmed')

        // The block is replaced; the transaction is re-included in another block.
        advance(1500)
        chain.set(
          p.hash,
          receipt({block: 903n, hash: blockHash('B'), logs: [good(p.units)]}),
        )
        expect(await reconciler.runOnce()).toMatchObject({reorged: 1})
        let r = await row(p.id)
        expect(r.status).toBe('reorged')
        expect(r.tx).toMatchObject({
          status: 'reorged',
          blockHash: blockHash('B'),
          blockNumber: 903n,
        })

        // Next poll: the new block is stable and deep, so it confirms again.
        advance(1500)
        chain.head = 910n
        expect(await reconciler.runOnce()).toMatchObject({confirmed: 1})
        r = await row(p.id)
        expect(r.status).toBe('confirmed')
        expect(r.tx!.blockHash).toBe(blockHash('B'))
      })

      it('detects a reorg when the receipt disappears, and clears the stale block', async () => {
        const p = await paid()
        chain.set(
          p.hash,
          receipt({block: 900n, hash: blockHash('A'), logs: [good(p.units)]}),
        )
        chain.head = 905n
        await reconciler.runOnce()
        expect((await row(p.id)).status).toBe('confirmed')

        advance(1500)
        chain.set(p.hash, null)
        expect(await reconciler.runOnce()).toMatchObject({reorged: 1})
        const r = await row(p.id)
        expect(r.status).toBe('reorged')
        expect(r.tx).toMatchObject({
          status: 'reorged',
          blockHash: null,
          blockNumber: null,
        })
        // The platform must not treat a reorged payment as paid.
        expect(r.status).not.toBe('confirmed')
      })

      it('keeps a confirmed payment confirmed when a lagging node reports an older head', async () => {
        const p = await paid()
        chain.set(
          p.hash,
          receipt({block: 900n, hash: blockHash('A'), logs: [good(p.units)]}),
        )
        chain.head = 910n
        await reconciler.runOnce()
        expect((await row(p.id)).status).toBe('confirmed')
        advance(31_000)
        chain.head = 901n // stale: only 2 confirmations
        const s = await reconciler.runOnce()
        expect(s).toMatchObject({confirmed: 1, failed: 0, stale: 0})
        expect((await row(p.id)).status).toBe('confirmed')
      })

      it('finalises deep payments and stops polling them', async () => {
        const p = await paid()
        chain.set(
          p.hash,
          receipt({block: 900n, hash: blockHash('A'), logs: [good(p.units)]}),
        )
        chain.head = 900n + BigInt(FINALITY) // >= finality depth
        await reconciler.runOnce()
        const r = await row(p.id)
        expect(r.status).toBe('confirmed')
        expect(r.finalizedAt).not.toBeNull()
        const calls = chain.receiptCalls
        advance(120_000)
        await reconciler.runOnce()
        expect(chain.receiptCalls).toBe(calls)
      })

      it('survives RPC timeouts without changing state, backs off, then recovers', async () => {
        const p = await paid()
        chain.set(
          p.hash,
          receipt({block: 900n, hash: blockHash('A'), logs: [good(p.units)]}),
        )
        chain.head = 1000n

        chain.failNext = [new RpcError('timeout', 'slow')]
        expect(await reconciler.runOnce()).toMatchObject({
          rpcErrors: 1,
          confirmed: 0,
        })
        let r = await row(p.id)
        expect(r.status).toBe('awaiting_confirmation')
        expect(r.tx!.status).toBe('pending')
        expect(r).toMatchObject({checkAttempts: 1, lastError: 'rpc_timeout'})

        // Backoff: not due again immediately.
        expect(await reconciler.runOnce()).toMatchObject({checked: 0})

        advance(30_000)
        chain.failNext = [new RpcError('unavailable', 'down')]
        await reconciler.runOnce()
        r = await row(p.id)
        expect(r).toMatchObject({
          checkAttempts: 2,
          lastError: 'rpc_unavailable',
        })

        advance(60_000)
        expect(await reconciler.runOnce()).toMatchObject({confirmed: 1})
        r = await row(p.id)
        expect(r).toMatchObject({
          status: 'confirmed',
          checkAttempts: 0,
          lastError: null,
        })
      })

      it('does not double-apply when two workers race on the same intent', async () => {
        const p = await paid()
        chain.set(
          p.hash,
          receipt({block: 900n, hash: blockHash('A'), logs: [good(p.units)]}),
        )
        chain.head = 1000n
        const second = new Reconciler({
          repo: tipRepo,
          reader: chain,
          chains,
          options: {leaseMs: 30_000},
          now: () => now,
        })
        const [a, b] = await Promise.all([
          reconciler.runOnce(),
          second.runOnce(),
        ])
        expect(a.checked + b.checked).toBe(1) // the lease let only one worker take it
        expect((await row(p.id)).status).toBe('confirmed')
      })

      it('rejects a stale write instead of overwriting newer state (idempotent updates)', async () => {
        const p = await paid()
        const r = await row(p.id)
        const update = {
          intentId: p.id,
          txId: r.tx!.id,
          expectedIntentStatus: 'awaiting_confirmation' as const,
          expectedTxStatus: 'pending' as const,
          intentStatus: 'confirmed' as const,
          txStatus: 'confirmed' as const,
          blockNumber: 900n,
          blockHash: blockHash('A'),
          confirmations: 9n,
          nextCheckAt: null,
          finalizedAt: null,
          now,
        }
        expect(await tipRepo.applyReconciliation(update)).toBe(true)
        // Replaying the same computed update finds the rows already changed.
        expect(await tipRepo.applyReconciliation(update)).toBe(false)
        expect((await row(p.id)).status).toBe('confirmed')
      })

      it('writes audit events for every payment state change, without secrets', async () => {
        const p = await paid()
        chain.set(
          p.hash,
          receipt({block: 900n, hash: blockHash('A'), logs: [good(p.units)]}),
        )
        chain.head = 1000n
        await reconciler.runOnce()
        const {rows} = await pool.query<{
          action: string
          outcome: string
          metadata: unknown
        }>(
          'SELECT action, outcome, metadata FROM audit_events ORDER BY occurred_at, id',
        )
        const actions = rows.map(r => r.action)
        expect(actions).toEqual(
          expect.arrayContaining([
            'tip.intent.create',
            'tip.tx.submit',
            'tip.payment.confirmed',
          ]),
        )
        expect(JSON.stringify(rows)).not.toMatch(
          /signature|privateKey|authorization/i,
        )
      })

      it('blocks wallet unlinking while the payment is in flight, and allows it afterwards', async () => {
        const p = await paid()
        const wallets = new WalletLinkService(
          walletRepo,
          new EoaSignatureVerifier(),
          testConfig(),
          () => now,
        )
        const link = (await walletRepo.listLinksForDid(BOB))[0]!
        await expect(wallets.unlinkWallet(BOB, link.id)).rejects.toMatchObject({
          code: 'open_payments',
        })
        chain.set(
          p.hash,
          receipt({block: 900n, hash: blockHash('A'), logs: [good(p.units)]}),
        )
        chain.head = 1000n
        await reconciler.runOnce()
        await expect(wallets.unlinkWallet(BOB, link.id)).resolves.toBeTruthy()
      })
    })

    it('stores and returns amounts exactly, at the configured maximum', async () => {
      const {body} = await create({amount: '100'})
      expect(body.tip.amountUnits).toBe('100000000')
      const {rows} = await pool.query<{amount: string}>(
        'SELECT amount::text FROM payment_intents',
      )
      expect(BigInt(rows[0]!.amount)).toBe(100_000_000n)
    })
  },
)

const rpc = process.env.BASE_SEPOLIA_RPC_URL

/**
 * The whole pipeline against the REAL chain: a real, third-party USDC transfer
 * on Base Sepolia is attached to an intent between two wallets we "link" in the
 * test database, then settled by the reconciler reading the real receipt.
 * Read-only: no transaction is sent and no key exists.
 */
describe.skipIf(!url || !rpc)(
  'reconciling a REAL Base Sepolia transfer',
  () => {
    it('confirms it and records the real block number and hash', async ctx => {
      const pool = new Pool({connectionString: url})
      try {
        await migrate(url!, 'up')
        await pool.query(
          'TRUNCATE audit_events, idempotency_keys, subscription_entitlements, creator_plans, chain_transactions, payment_intents, wallet_challenges, user_wallets CASCADE',
        )
        const reader = new ViemChainReader({[CHAIN]: rpc!}, 15_000)
        const real = await findRealTransfer(reader, CHAIN)
        if (!real) return ctx.skip()

        const chains = buildChainConfigs({
          ALLOWED_CHAIN_IDS: [CHAIN],
          USDC_ADDRESSES: {[CHAIN]: USDC},
        })
        const walletRepo = new PgWalletRepository(pool)
        const tipRepo = new PgTipRepository(pool)
        const when = new Date()
        await walletRepo.insertLink({
          did: ALICE,
          chainId: CHAIN,
          address: real.from.toLowerCase(),
          verifiedAt: when,
        })
        await walletRepo.insertLink({
          did: BOB,
          chainId: CHAIN,
          address: real.to.toLowerCase(),
          verifiedAt: when,
        })
        // A throwaway intent for exactly this transfer. (The real transfer may be
        // smaller than the default minimum, so the bound is lowered for the test.)
        const tips = new TippingService({
          repo: tipRepo,
          wallets: walletRepo,
          chains,
          tokens: new Map([
            [
              CHAIN,
              {
                chainId: CHAIN,
                address: USDC,
                symbol: 'USDC' as const,
                decimals: 6 as const,
              },
            ],
          ]),
          config: {
            ...testConfig(),
            TIP_MIN_UNITS: 1n,
            TIP_MAX_UNITS: 10n ** 30n,
          },
          idempotency: new PgIdempotencyStore(pool),
        })
        if (real.from.toLowerCase() === real.to.toLowerCase()) return ctx.skip()
        const created = await tips.createIntent(
          ALICE,
          {
            recipientDid: BOB,
            chainId: CHAIN,
            amount: formatTokenAmount(real.amount, 6),
            senderAddress: real.from,
          },
          'live-real-transfer-1',
        )
        await tips.submitTransaction(ALICE, {
          intentId: created.body.tip.id,
          txHash: real.hash,
        })

        const reconciler = new Reconciler({repo: tipRepo, reader, chains})
        const summary = await reconciler.runOnce()
        expect(summary).toMatchObject({confirmed: 1, failed: 0})

        const settled = (await tipRepo.getIntent(created.body.tip.id))!
        expect(settled.status).toBe('confirmed')
        expect(settled.tx).toMatchObject({
          status: 'confirmed',
          blockNumber: real.receipt.blockNumber,
          blockHash: real.receipt.blockHash,
        })
        expect(settled.amount).toBe(real.amount)
      } finally {
        await pool.end()
      }
    })
  },
)
