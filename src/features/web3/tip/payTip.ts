import {Web3ApiError} from '#/features/web3/api/client'
import {type PreparedTransfer, type Tip} from '#/features/web3/api/types'
import {WalletError} from '#/features/web3/wallet/types'

export type TipFailure =
  | 'wallet_rejected'
  | 'wrong_network'
  | 'not_connected'
  | 'sender_wallet_not_linked'
  | 'recipient_not_tippable'
  | 'amount_invalid'
  | 'tipping_unavailable'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown'

/**
 * The payment could not be completed. If `txHash` is set, the wallet DID send a
 * transaction and only reporting it to the service failed: retry
 * {@link submitSentTransaction}, never send again.
 */
export class TipError extends Error {
  readonly reason: TipFailure
  readonly tipId?: string
  readonly txHash?: string

  constructor(
    reason: TipFailure,
    extra: {tipId?: string; txHash?: string} = {},
  ) {
    super(reason)
    this.name = 'TipError'
    this.reason = reason
    this.tipId = extra.tipId
    this.txHash = extra.txHash
  }
}

export function mapTipError(e: unknown): TipFailure {
  if (e instanceof WalletError) {
    switch (e.reason) {
      case 'rejected':
        return 'wallet_rejected'
      case 'wrong_network':
        return 'wrong_network'
      case 'not_connected':
        return 'not_connected'
      default:
        return 'unknown'
    }
  }
  if (e instanceof Web3ApiError) {
    switch (e.code) {
      case 'sender_wallet_not_linked':
        return 'sender_wallet_not_linked'
      case 'recipient_not_tippable':
        return 'recipient_not_tippable'
      case 'invalid_amount':
      case 'amount_too_small':
      case 'amount_too_large':
      case 'cannot_tip_self':
      case 'invalid_post_uri':
        return 'amount_invalid'
      case 'tipping_unavailable':
        return 'tipping_unavailable'
      case 'rate_limited':
        return 'rate_limited'
    }
    if (e.status === 429) return 'rate_limited'
    if (e.status >= 500) return 'unavailable'
  }
  return 'unknown'
}

type Api = {
  createTipIntent(i: {
    recipientDid: string
    chainId: number
    amount: string
    senderAddress: string
    postUri?: string
    idempotencyKey: string
  }): Promise<{tip: Tip; transfer: PreparedTransfer}>
  submitTipTransaction(i: {intentId: string; txHash: string}): Promise<Tip>
}

type Wallet = {
  sendTransaction(tx: PreparedTransfer): Promise<`0x${string}`>
}

/**
 * Reports a transaction hash the wallet returned. Safe to call again: the
 * service ignores a hash it already has for this payment.
 */
export async function submitSentTransaction(
  api: Pick<Api, 'submitTipTransaction'>,
  tipId: string,
  txHash: string,
): Promise<Tip> {
  try {
    return await api.submitTipTransaction({intentId: tipId, txHash})
  } catch (e) {
    throw new TipError('unavailable', {tipId, txHash})
  }
}

/**
 * Sends one tip: create the payment intent, ask the user's wallet to send the
 * prepared transfer, then tell the service which transaction it was.
 *
 * Guarantees, each covered by tests:
 * - Only runs when called, which the UI only does from an explicit "Confirm"
 *   press. Nothing is ever started automatically.
 * - The wallet is asked to send ONLY after the service created an intent for
 *   exactly this amount and recipient, and the transfer it is asked to send is
 *   the service's, not one assembled here.
 * - A rejected or failed wallet request never reaches the service as a payment.
 * - If the wallet sent but reporting failed, the error carries the hash so the
 *   caller retries only the report. The wallet is never asked twice.
 *
 * The returned status is "awaiting_confirmation" at best. Whether the payment
 * actually happened is decided later by the service reading the chain.
 */
export async function payTip(deps: {
  api: Api
  wallet: Wallet
  input: {
    recipientDid: string
    chainId: number
    amount: string
    senderAddress: string
    postUri?: string
  }
  /** Same key for retries of the same attempt, so at most one intent exists. */
  idempotencyKey: string
  onStage?: (stage: 'creating' | 'awaiting_wallet' | 'reporting') => void
}): Promise<{tip: Tip; txHash: string}> {
  let created
  try {
    deps.onStage?.('creating')
    created = await deps.api.createTipIntent({
      ...deps.input,
      idempotencyKey: deps.idempotencyKey,
    })
  } catch (e) {
    throw new TipError(mapTipError(e))
  }

  let txHash: `0x${string}`
  try {
    deps.onStage?.('awaiting_wallet')
    txHash = await deps.wallet.sendTransaction(created.transfer)
  } catch (e) {
    throw new TipError(mapTipError(e), {tipId: created.tip.id})
  }

  deps.onStage?.('reporting')
  const tip = await submitSentTransaction(deps.api, created.tip.id, txHash)
  return {tip, txHash}
}

/** A fresh idempotency key for one attempt. Fails closed without a CSPRNG. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto
  if (!c?.getRandomValues) throw new TipError('unavailable')
  const bytes = c.getRandomValues(new Uint8Array(18))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
