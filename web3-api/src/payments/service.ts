import {type Address, type Hex} from 'viem'

import {type PreparedTransfer} from './erc20.ts'
import {type TxVerdict} from './receipt.ts'
import {type PaymentIntent} from './types.ts'

/**
 * USDC tipping on Base, wallet to wallet. Interface only in Phase 1: there is
 * no implementation and nothing here is wired to a route.
 *
 * Flow: `createIntent` -> client signs and sends the prepared transfer from its
 * own wallet -> `submitTransaction` -> `reconcile` (polled) -> confirmed.
 * The platform never holds or moves funds.
 */
export interface TippingService {
  /**
   * Requires both parties to have a verified wallet on `chainId`, validates the
   * amount against the token's decimals, and snapshots both addresses.
   */
  createIntent(
    senderDid: string,
    input: {recipientDid: string; chainId: number; amount: string},
  ): Promise<PaymentIntent>

  /** Builds the unsigned ERC-20 transfer. Sends nothing. */
  prepareTransfer(
    senderDid: string,
    intentId: string,
  ): Promise<PreparedTransfer>

  /**
   * Records a transaction hash for an intent. Must reject a hash already
   * attached to any intent (duplicate-event protection).
   */
  submitTransaction(
    senderDid: string,
    intentId: string,
    txHash: Hex,
  ): Promise<void>

  /**
   * Re-reads the chain and applies {@link TxVerdict}, including reorg handling.
   * Idempotent: safe to call repeatedly from a worker.
   */
  reconcile(intentId: string): Promise<TxVerdict>
}

export type VerifiedRecipient = {did: string; address: Address; chainId: number}
