import {type AuditLog} from '../audit.ts'
import {type ChainReader, RpcError} from '../chain/reader.ts'
import {type ChainConfig} from './chains.ts'
import {
  evaluateTransaction,
  nextTransactionStatus,
  type TxVerdict,
} from './receipt.ts'
import {type TipRecord, type TipRepository} from './tip-types.ts'
import {type PaymentIntentStatus} from './types.ts'

export type ReconcilerOptions = {
  /** Poll interval for payments that are pending or recently confirmed. */
  pollIntervalMs: number
  batchSize: number
  /** How long a leased intent is hidden from other workers. */
  leaseMs: number
  /** Intent whose transaction was never seen on chain is expired after this. */
  neverSeenAfterMs: number
  /** Upper bound for RPC-failure backoff. */
  maxBackoffMs: number
}

export const DEFAULT_RECONCILER_OPTIONS: ReconcilerOptions = {
  pollIntervalMs: 5000,
  batchSize: 20,
  leaseMs: 60_000,
  neverSeenAfterMs: 6 * 3_600_000,
  maxBackoffMs: 5 * 60_000,
}

export type ReconcileSummary = {
  expired: number
  checked: number
  confirmed: number
  failed: number
  reorged: number
  pending: number
  rpcErrors: number
  stale: number
}

type Log = (obj: Record<string, unknown>, msg: string) => void

/** Intent status implied by a transaction verdict. */
function intentStatusFor(verdict: TxVerdict): PaymentIntentStatus {
  switch (verdict.kind) {
    case 'confirmed':
      return 'confirmed'
    case 'failed':
      return 'failed'
    case 'reorged':
      return 'reorged'
    default:
      return 'awaiting_confirmation'
  }
}

/**
 * Settles payment intents against the chain.
 *
 * - Works only from receipts read from the chain; the client's word is never
 *   used. A payment is confirmed only when exactly one `Transfer` log from the
 *   verified token matches sender, recipient and amount, with enough
 *   confirmations (see `evaluateTransaction`).
 * - Idempotent: every write is conditional on the previous state, so running a
 *   check twice, or two workers racing, cannot double-apply anything.
 * - Reorg-aware: block hash and number are recorded; a changed hash or a
 *   vanished receipt moves the payment to `reorged` and it keeps being polled.
 * - Transient RPC failures (timeouts, outages) change no payment state; the
 *   intent is retried with exponential backoff and the failure kind recorded.
 * - Holds no keys and sends nothing.
 */
export class Reconciler {
  private readonly repo: TipRepository
  private readonly reader: ChainReader
  private readonly chains: ReadonlyMap<number, ChainConfig>
  private readonly opts: ReconcilerOptions
  private readonly audit: AuditLog | undefined
  private readonly now: () => Date
  private readonly log: Log

  constructor(deps: {
    repo: TipRepository
    reader: ChainReader
    chains: ReadonlyMap<number, ChainConfig>
    options?: Partial<ReconcilerOptions>
    audit?: AuditLog
    now?: () => Date
    log?: Log
  }) {
    this.repo = deps.repo
    this.reader = deps.reader
    this.chains = deps.chains
    this.opts = {...DEFAULT_RECONCILER_OPTIONS, ...deps.options}
    this.audit = deps.audit
    this.now = deps.now ?? (() => new Date())
    this.log = deps.log ?? (() => {})
  }

  async runOnce(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      expired: 0,
      checked: 0,
      confirmed: 0,
      failed: 0,
      reorged: 0,
      pending: 0,
      rpcErrors: 0,
      stale: 0,
    }
    summary.expired = await this.repo.expireStale(
      this.now(),
      this.opts.neverSeenAfterMs,
    )
    const due = await this.repo.claimDue(
      this.opts.batchSize,
      this.now(),
      this.opts.leaseMs,
    )
    for (const tip of due) {
      try {
        const outcome = await this.reconcile(tip)
        summary.checked++
        summary[outcome]++
      } catch (e) {
        // One bad intent must not stop the batch.
        this.log({err: e, intentId: tip.id}, 'reconcile failed unexpectedly')
      }
    }
    return summary
  }

  private async reconcile(
    tip: TipRecord,
  ): Promise<
    'confirmed' | 'failed' | 'reorged' | 'pending' | 'rpcErrors' | 'stale'
  > {
    const chain = this.chains.get(tip.chainId)
    const tx = tip.tx
    if (!chain || !tx) {
      // Nothing to check (no transaction yet, or the chain was disabled).
      return 'pending'
    }

    let receipt, head
    try {
      ;[receipt, head] = await Promise.all([
        this.reader.getTransactionReceipt(tip.chainId, tx.hash),
        this.reader.getBlockNumber(tip.chainId),
      ])
    } catch (e) {
      const kind = e instanceof RpcError ? e.kind : 'unexpected'
      const attempts = tip.checkAttempts + 1
      const delay = Math.min(
        this.opts.maxBackoffMs,
        this.opts.pollIntervalMs * 2 ** attempts,
      )
      await this.repo.recordRpcFailure(
        tip.id,
        `rpc_${kind}`,
        new Date(this.now().getTime() + delay),
        this.now(),
      )
      return 'rpcErrors'
    }

    const evaluated = evaluateTransaction({
      expected: {
        token: tip.tokenAddress,
        from: tip.senderWalletAddress,
        to: tip.recipientWalletAddress,
        amount: tip.amount,
      },
      receipt,
      head,
      requiredConfirmations: chain.requiredConfirmations,
      previousBlockHash: tx.blockHash,
    })

    /*
     * A matching transfer mined before the intent existed is a replay of an old
     * payment, not the payment this intent asked for.
     */
    const raw: TxVerdict =
      receipt &&
      evaluated.kind !== 'reorged' &&
      tip.minBlockNumber !== null &&
      receipt.blockNumber <= tip.minBlockNumber
        ? {kind: 'failed', reason: 'predates_intent'}
        : evaluated

    /*
     * A lagging RPC node can report a chain head behind the block that already
     * confirmed this payment, which would read as "awaiting confirmations". The
     * receipt is unchanged (same block hash), so this is not new information:
     * keep the confirmed state instead of treating it as a transition.
     */
    const verdict: TxVerdict =
      raw.kind === 'pending' &&
      raw.reason === 'awaiting_confirmations' &&
      tx.status === 'confirmed' &&
      receipt?.blockHash === tx.blockHash
        ? {kind: 'confirmed'}
        : raw

    const now = this.now()
    const txStatus = nextTransactionStatus(tx.status, verdict)
    const intentStatus = intentStatusFor(verdict)
    const confirmations =
      receipt && head >= receipt.blockNumber
        ? head - receipt.blockNumber + 1n
        : null

    let finalizedAt: Date | null = null
    let nextCheckAt: Date | null = new Date(
      now.getTime() + this.opts.pollIntervalMs,
    )
    if (verdict.kind === 'failed') {
      finalizedAt = now
      nextCheckAt = null
    } else if (
      verdict.kind === 'confirmed' &&
      confirmations !== null &&
      confirmations >= BigInt(chain.finalityDepth)
    ) {
      // Deep enough that a reorg is no longer a practical concern.
      finalizedAt = now
      nextCheckAt = null
    }

    const applied = await this.repo.applyReconciliation({
      intentId: tip.id,
      txId: tx.id,
      expectedIntentStatus: tip.status,
      expectedTxStatus: tx.status,
      intentStatus,
      txStatus,
      // After a reorg the new block (if any) replaces the stale one; if the
      // receipt vanished the hash is cleared so the next poll starts fresh.
      blockNumber: receipt?.blockNumber ?? null,
      blockHash: receipt?.blockHash ?? null,
      confirmations,
      nextCheckAt,
      finalizedAt,
      now,
    })
    if (!applied) return 'stale'

    if (intentStatus !== tip.status) {
      await this.audit?.record({
        action: `tip.payment.${intentStatus}`,
        actorDid: tip.senderDid,
        subjectType: 'payment_intent',
        subjectId: tip.id,
        outcome: intentStatus === 'failed' ? 'failure' : 'success',
        reason: verdict.kind === 'failed' ? verdict.reason : undefined,
        metadata: {
          chainId: tip.chainId,
          from: tip.status,
          to: intentStatus,
          blockNumber: receipt?.blockNumber.toString() ?? null,
          previousBlockHash: tx.blockHash,
          blockHash: receipt?.blockHash ?? null,
        },
      })
    }
    return verdict.kind === 'confirmed'
      ? 'confirmed'
      : verdict.kind === 'failed'
        ? 'failed'
        : verdict.kind === 'reorged'
          ? 'reorged'
          : 'pending'
  }
}
