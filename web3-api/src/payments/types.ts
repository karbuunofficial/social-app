import {type Address, type Hex} from 'viem'

export type PaymentIntentStatus =
  | 'created'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'reorged'

export type ChainTransactionStatus =
  'pending' | 'confirmed' | 'failed' | 'reorged'

/**
 * A request to pay a verified recipient wallet. `amount` is integer base
 * units (a bigint), never a JavaScript number.
 */
export type PaymentIntent = {
  id: string
  senderDid: string
  recipientDid: string
  chainId: number
  tokenAddress: Address
  senderWalletAddress: Address
  recipientWalletAddress: Address
  amount: bigint
  status: PaymentIntentStatus
  expiresAt: Date
  createdAt: Date
}

export type ChainTransaction = {
  id: string
  chainId: number
  txHash: Hex
  paymentIntentId: string | null
  status: ChainTransactionStatus
  blockNumber: bigint | null
  blockHash: Hex | null
}

/** What the sender's wallet must do. Nothing here moves funds by itself. */
export type TransferExpectation = {
  token: Address
  from: Address
  to: Address
  amount: bigint
}
