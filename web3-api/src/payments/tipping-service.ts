import {getAddress, type Hex} from 'viem'

import {type AuditLog} from '../audit.ts'
import {type Config} from '../config.ts'
import {
  badRequest,
  conflict,
  notFound,
  tooManyRequests,
  unprocessable,
} from '../errors.ts'
import {assertValidKey, type IdempotencyStore} from '../idempotency.ts'
import {type RequestContext} from '../wallet/service.ts'
import {type WalletRepository} from '../wallet/types.ts'
import {formatTokenAmount, parsePositiveTokenAmount} from './amounts.ts'
import {type ChainConfig} from './chains.ts'
import {type PreparedTransfer, prepareUsdcTransfer} from './erc20.ts'
import {type TipRecord, type TipRepository} from './tip-types.ts'
import {type VerifiedToken} from './token-check.ts'

const HOUR_MS = 3_600_000
/** A transaction may still be attached this long after an intent expired. */
export const REVIVE_WINDOW_MS = 24 * HOUR_MS

const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const AT_URI =
  /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]+)\/[a-zA-Z0-9.]+\/[a-zA-Z0-9._~:-]+$/

export type TipServiceConfig = Pick<
  Config,
  | 'TIP_MIN_UNITS'
  | 'TIP_MAX_UNITS'
  | 'TIP_INTENT_TTL_SECONDS'
  | 'TIP_INTENTS_PER_HOUR'
>

/** What the API returns for a payment intent. Amounts are decimal strings. */
export type PublicTip = {
  id: string
  status: TipRecord['status']
  chainId: number
  senderDid: string
  recipientDid: string
  senderAddress: string
  recipientAddress: string
  token: {address: string; symbol: 'USDC'; decimals: 6}
  /** Integer base units as a decimal string. */
  amountUnits: string
  /** Human-readable USDC amount, derived from the integer. */
  amount: string
  postUri: string | null
  expiresAt: string
  createdAt: string
  requiredConfirmations: number
  transaction: {
    hash: string
    status: string
    blockNumber: string | null
    confirmations: string | null
    explorerUrl: string
  } | null
}

export type RecipientInfo =
  | {tippable: false; reason: string}
  | {
      tippable: true
      chainId: number
      recipientAddress: string
      token: {address: string; symbol: 'USDC'; decimals: 6}
    }

export class TippingService {
  private readonly repo: TipRepository
  private readonly wallets: WalletRepository
  private readonly chains: ReadonlyMap<number, ChainConfig>
  private readonly tokens: ReadonlyMap<number, VerifiedToken>
  private readonly config: TipServiceConfig
  private readonly idempotency: IdempotencyStore
  private readonly audit: AuditLog | undefined
  private readonly now: () => Date

  constructor(deps: {
    repo: TipRepository
    wallets: WalletRepository
    chains: ReadonlyMap<number, ChainConfig>
    /** Tokens verified on chain. A chain absent here cannot be tipped on. */
    tokens: ReadonlyMap<number, VerifiedToken>
    config: TipServiceConfig
    idempotency: IdempotencyStore
    audit?: AuditLog
    now?: () => Date
  }) {
    this.repo = deps.repo
    this.wallets = deps.wallets
    this.chains = deps.chains
    this.tokens = deps.tokens
    this.config = deps.config
    this.idempotency = deps.idempotency
    this.audit = deps.audit
    this.now = deps.now ?? (() => new Date())
  }

  /** Chains on which tipping is currently possible. */
  enabledChains(): {chain: ChainConfig; token: VerifiedToken}[] {
    return [...this.tokens.entries()].flatMap(([id, token]) => {
      const chain = this.chains.get(id)
      return chain ? [{chain, token}] : []
    })
  }

  private tippingTarget(chainId: number) {
    const chain = this.chains.get(chainId)
    const token = this.tokens.get(chainId)
    // Mainnet is refused here as well as in config: defence in depth.
    if (!chain || !token || !chain.isTestnet) {
      throw unprocessable(
        'tipping_unavailable',
        'Tipping is not available on this network',
      )
    }
    return {chain, token}
  }

  toPublic(t: TipRecord): PublicTip {
    const chain = this.chains.get(t.chainId)
    const token = this.tokens.get(t.chainId)
    return {
      id: t.id,
      status: t.status,
      chainId: t.chainId,
      senderDid: t.senderDid,
      recipientDid: t.recipientDid,
      senderAddress: getAddress(t.senderWalletAddress),
      recipientAddress: getAddress(t.recipientWalletAddress),
      token: {address: getAddress(t.tokenAddress), symbol: 'USDC', decimals: 6},
      amountUnits: t.amount.toString(),
      amount: formatTokenAmount(t.amount, token?.decimals ?? 6),
      postUri: t.postUri,
      expiresAt: t.expiresAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      requiredConfirmations: chain?.requiredConfirmations ?? 0,
      transaction: t.tx
        ? {
            hash: t.tx.hash,
            status: t.tx.status,
            blockNumber: t.tx.blockNumber?.toString() ?? null,
            confirmations: t.tx.confirmations?.toString() ?? null,
            explorerUrl: `${chain?.explorerUrl ?? ''}/tx/${t.tx.hash}`,
          }
        : null,
    }
  }

  /** The recipient's tipping wallet on a chain, newest verified link. */
  private async recipientWallet(recipientDid: string, chainId: number) {
    const links = (await this.wallets.listLinksForDid(recipientDid)).filter(
      l => l.chainId === chainId,
    )
    links.sort((a, b) => b.verifiedAt.getTime() - a.verifiedAt.getTime())
    return links[0] ?? null
  }

  async getRecipient(
    recipientDid: string,
    chainId: number,
  ): Promise<RecipientInfo> {
    let target: ReturnType<TippingService['tippingTarget']>
    try {
      target = this.tippingTarget(chainId)
    } catch {
      return {tippable: false, reason: 'tipping_unavailable'}
    }
    const wallet = await this.recipientWallet(recipientDid, chainId)
    if (!wallet)
      return {tippable: false, reason: 'recipient_has_no_verified_wallet'}
    return {
      tippable: true,
      chainId,
      recipientAddress: getAddress(wallet.address),
      token: {address: target.token.address, symbol: 'USDC', decimals: 6},
    }
  }

  async createIntent(
    senderDid: string,
    input: {
      recipientDid: string
      chainId: number
      /** Decimal USDC string such as "1.50". Parsed with bigint maths. */
      amount: string
      senderAddress: string
      postUri?: string | undefined
    },
    idempotencyKey: string | undefined,
    ctx?: RequestContext,
  ): Promise<{
    status: number
    body: {tip: PublicTip; transfer: PreparedTransfer}
    replayed: boolean
  }> {
    const key = assertValidKey(idempotencyKey)
    return this.idempotency.run(
      {
        did: senderDid,
        operation: 'tip.createIntent',
        key,
        request: input,
        now: this.now(),
      },
      async () => {
        try {
          const body = await this.createIntentOnce(senderDid, input)
          await this.audit?.record({
            action: 'tip.intent.create',
            actorDid: senderDid,
            subjectType: 'payment_intent',
            subjectId: body.tip.id,
            outcome: 'success',
            requestId: ctx?.requestId,
            metadata: {
              chainId: input.chainId,
              amountUnits: body.tip.amountUnits,
            },
          })
          return {status: 201, body}
        } catch (e) {
          await this.audit?.record({
            action: 'tip.intent.create',
            actorDid: senderDid,
            outcome: 'denied',
            reason: (e as {code?: string}).code ?? 'error',
            requestId: ctx?.requestId,
            metadata: {chainId: input.chainId},
          })
          throw e
        }
      },
    )
  }

  private async createIntentOnce(
    senderDid: string,
    input: {
      recipientDid: string
      chainId: number
      amount: string
      senderAddress: string
      postUri?: string | undefined
    },
  ) {
    const {chain, token} = this.tippingTarget(input.chainId)
    const now = this.now()

    if (input.recipientDid === senderDid) {
      throw unprocessable('cannot_tip_self', 'You cannot tip yourself')
    }

    let units: bigint
    try {
      units = parsePositiveTokenAmount(input.amount, token.decimals)
    } catch {
      throw badRequest(
        'invalid_amount',
        'Amount must be a positive decimal with at most 6 decimal places',
      )
    }
    if (units < this.config.TIP_MIN_UNITS) {
      throw unprocessable(
        'amount_too_small',
        `Minimum tip is ${formatTokenAmount(this.config.TIP_MIN_UNITS, token.decimals)} USDC`,
      )
    }
    if (units > this.config.TIP_MAX_UNITS) {
      throw unprocessable(
        'amount_too_large',
        `Maximum tip is ${formatTokenAmount(this.config.TIP_MAX_UNITS, token.decimals)} USDC`,
      )
    }

    let postUri: string | null = null
    if (input.postUri) {
      const m = AT_URI.exec(input.postUri)
      // The post must belong to the recipient, so a tip cannot be attributed
      // to someone else's post.
      if (!m || m[1] !== input.recipientDid) {
        throw badRequest(
          'invalid_post_uri',
          'The post does not belong to the recipient',
        )
      }
      postUri = input.postUri
    }

    const sent = await this.repo.countCreatedSince(
      senderDid,
      new Date(now.getTime() - HOUR_MS),
    )
    if (sent >= this.config.TIP_INTENTS_PER_HOUR) throw tooManyRequests(300)

    // Both ends must be verified, active links on this chain.
    const senderWallet = (await this.wallets.listLinksForDid(senderDid)).find(
      l =>
        l.chainId === input.chainId &&
        l.address === input.senderAddress.toLowerCase(),
    )
    if (!senderWallet) {
      throw unprocessable(
        'sender_wallet_not_linked',
        'Pay from a wallet that is linked to your account on this network',
      )
    }
    const recipient = await this.recipientWallet(
      input.recipientDid,
      input.chainId,
    )
    if (!recipient) {
      throw unprocessable(
        'recipient_not_tippable',
        'The recipient has no verified wallet on this network',
      )
    }

    const tip = await this.repo.createIntent({
      senderDid,
      recipientDid: input.recipientDid,
      chainId: input.chainId,
      tokenAddress: token.address,
      senderWalletAddress: getAddress(senderWallet.address),
      recipientWalletAddress: getAddress(recipient.address),
      amount: units,
      postUri,
      expiresAt: new Date(
        now.getTime() + this.config.TIP_INTENT_TTL_SECONDS * 1000,
      ),
      createdAt: now,
    })
    return {
      tip: this.toPublic(tip),
      // Unsigned. The user's own wallet signs and sends it; we never can.
      transfer: prepareUsdcTransfer({
        chain: {...chain, usdcAddress: token.address},
        recipient: getAddress(recipient.address),
        amount: units,
      }),
    }
  }

  /**
   * Records the transaction hash the user's wallet returned. This does NOT mark
   * anything paid: only the reconciler, reading the chain, can do that.
   */
  async submitTransaction(
    senderDid: string,
    input: {intentId: string; txHash: string},
    ctx?: RequestContext,
  ): Promise<PublicTip> {
    if (!TX_HASH.test(input.txHash)) {
      throw badRequest('invalid_tx_hash', 'Invalid transaction hash')
    }
    const result = await this.repo.attachTransaction({
      intentId: input.intentId,
      senderDid,
      txHash: input.txHash.toLowerCase() as Hex,
      now: this.now(),
      reviveWindowMs: REVIVE_WINDOW_MS,
    })
    const audit = (outcome: 'success' | 'denied', reason?: string) =>
      this.audit?.record({
        action: 'tip.tx.submit',
        actorDid: senderDid,
        subjectType: 'payment_intent',
        subjectId: input.intentId,
        outcome,
        reason,
        requestId: ctx?.requestId,
      })
    switch (result.kind) {
      case 'attached':
        await audit('success')
        return this.toPublic(result.tip)
      case 'not_found':
        await audit('denied', 'not_found')
        throw notFound('intent_not_found', 'Payment not found')
      case 'duplicate_transaction':
        await audit('denied', 'duplicate_transaction')
        throw conflict(
          'duplicate_transaction',
          'This transaction was already submitted',
        )
      case 'already_has_transaction':
        await audit('denied', 'already_has_transaction')
        throw conflict(
          'already_has_transaction',
          'A transaction is already attached to this payment',
        )
      default:
        await audit('denied', `state_${result.status}`)
        throw unprocessable(
          'wrong_state',
          `This payment can no longer accept a transaction (${result.status})`,
        )
    }
  }

  /** Visible to the sender and recipient only; everyone else gets a 404. */
  async getIntent(did: string, id: string): Promise<PublicTip> {
    const tip = /^[0-9a-f-]{36}$/i.test(id)
      ? await this.repo.getIntent(id)
      : null
    if (!tip || (tip.senderDid !== did && tip.recipientDid !== did)) {
      throw notFound('intent_not_found', 'Payment not found')
    }
    return this.toPublic(tip)
  }

  async listIntents(
    did: string,
    role: 'sent' | 'received',
  ): Promise<PublicTip[]> {
    return (await this.repo.listIntents(did, role, 50)).map(t =>
      this.toPublic(t),
    )
  }
}
