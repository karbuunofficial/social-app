import {type Address, type Hex} from 'viem'

import {type ChainTransactionStatus, type PaymentIntentStatus} from './types.ts'

/** A payment intent together with its (at most one) attached transaction. */
export type TipRecord = {
  id: string
  senderDid: string
  recipientDid: string
  chainId: number
  tokenAddress: Address
  senderWalletAddress: Address
  recipientWalletAddress: Address
  /** Integer base units. */
  amount: bigint
  status: PaymentIntentStatus
  postUri: string | null
  expiresAt: Date
  createdAt: Date
  checkAttempts: number
  lastError: string | null
  finalizedAt: Date | null
  tx: {
    id: string
    hash: Hex
    status: ChainTransactionStatus
    blockNumber: bigint | null
    blockHash: Hex | null
    confirmations: bigint | null
    createdAt: Date
  } | null
}

export type NewTip = {
  senderDid: string
  recipientDid: string
  chainId: number
  tokenAddress: Address
  senderWalletAddress: Address
  recipientWalletAddress: Address
  amount: bigint
  postUri: string | null
  expiresAt: Date
  createdAt: Date
}

export type AttachResult =
  | {kind: 'attached'; tip: TipRecord}
  | {kind: 'not_found'}
  | {kind: 'wrong_state'; status: PaymentIntentStatus}
  | {kind: 'already_has_transaction'}
  | {kind: 'duplicate_transaction'}

export type ReconcileUpdate = {
  intentId: string
  txId: string
  /** The states this update was computed from; the write is skipped if stale. */
  expectedIntentStatus: PaymentIntentStatus
  expectedTxStatus: ChainTransactionStatus
  intentStatus: PaymentIntentStatus
  txStatus: ChainTransactionStatus
  blockNumber: bigint | null
  blockHash: Hex | null
  confirmations: bigint | null
  nextCheckAt: Date | null
  finalizedAt: Date | null
  now: Date
}

export interface TipRepository {
  createIntent(input: NewTip): Promise<TipRecord>
  getIntent(id: string): Promise<TipRecord | null>
  listIntents(
    did: string,
    role: 'sent' | 'received',
    limit: number,
  ): Promise<TipRecord[]>
  countCreatedSince(senderDid: string, since: Date): Promise<number>
  attachTransaction(input: {
    intentId: string
    senderDid: string
    txHash: Hex
    now: Date
    /** An expired intent may still be revived within this window. */
    reviveWindowMs: number
  }): Promise<AttachResult>
  /**
   * Leases up to `limit` intents that are due for a check, pushing their
   * `next_check_at` out by `leaseMs` so concurrent workers skip them.
   */
  claimDue(limit: number, now: Date, leaseMs: number): Promise<TipRecord[]>
  /** Returns false when the rows changed since the update was computed. */
  applyReconciliation(update: ReconcileUpdate): Promise<boolean>
  recordRpcFailure(
    intentId: string,
    kind: string,
    nextCheckAt: Date,
    now: Date,
  ): Promise<void>
  /** Expires unpaid intents and intents whose transaction never appeared. */
  expireStale(now: Date, neverSeenAfterMs: number): Promise<number>
}
