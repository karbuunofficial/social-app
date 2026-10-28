import {getAddress, type Hex, hexToBigInt} from 'viem'

import {ERC20_TRANSFER_TOPIC} from './erc20.ts'
import {type ChainTransactionStatus, type TransferExpectation} from './types.ts'

export type ChainLog = {address: string; topics: readonly Hex[]; data: Hex}

export type ChainReceipt = {
  status: 'success' | 'reverted'
  blockNumber: bigint
  blockHash: Hex
  logs: readonly ChainLog[]
}

export type TxVerdict =
  | {kind: 'pending'; reason: 'not_found' | 'awaiting_confirmations'}
  | {kind: 'confirmed'}
  | {
      kind: 'failed'
      reason: 'reverted' | 'no_matching_transfer' | 'predates_intent'
    }
  | {kind: 'reorged'}

const topicToAddress = (topic: Hex | undefined) =>
  topic && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic)
    ? getAddress(`0x${topic.slice(26)}`)
    : null

/**
 * True when the receipt contains exactly one ERC-20 `Transfer` from the
 * expected token that matches sender, recipient and the exact amount. Receipts
 * are checked by logs (what actually happened), never by the calldata that was
 * submitted. Exact amount is required: an overpayment or underpayment is not a
 * match.
 */
export function hasMatchingTransfer(
  receipt: ChainReceipt,
  expected: TransferExpectation,
): boolean {
  const matches = receipt.logs.filter(log => {
    if (getAddress(log.address) !== getAddress(expected.token)) return false
    if (log.topics.length !== 3 || log.topics[0] !== ERC20_TRANSFER_TOPIC) {
      return false
    }
    if (topicToAddress(log.topics[1]) !== getAddress(expected.from))
      return false
    if (topicToAddress(log.topics[2]) !== getAddress(expected.to)) return false
    return log.data.length === 66 && hexToBigInt(log.data) === expected.amount
  })
  return matches.length === 1
}

/**
 * Decides what a (re-)fetched receipt means.
 *
 * Reorganisation handling: callers persist `blockHash` when first seeing a
 * receipt. If a later fetch returns no receipt, or one with a different block
 * hash, the earlier observation is no longer canonical, so the verdict is
 * `reorged` and any access granted from it must be revoked.
 */
export function evaluateTransaction(input: {
  expected: TransferExpectation
  /** Null when the node does not know the transaction (yet). */
  receipt: ChainReceipt | null
  /** Current chain head block number. */
  head: bigint
  requiredConfirmations: number
  /** Block hash recorded at an earlier observation, if any. */
  previousBlockHash?: Hex | null
}): TxVerdict {
  const {receipt, previousBlockHash} = input

  if (!receipt) {
    return previousBlockHash
      ? {kind: 'reorged'}
      : {kind: 'pending', reason: 'not_found'}
  }
  if (previousBlockHash && previousBlockHash !== receipt.blockHash) {
    return {kind: 'reorged'}
  }
  if (receipt.status === 'reverted') {
    return {kind: 'failed', reason: 'reverted'}
  }
  if (!hasMatchingTransfer(receipt, input.expected)) {
    return {kind: 'failed', reason: 'no_matching_transfer'}
  }
  const confirmations = input.head - receipt.blockNumber + 1n
  if (confirmations < BigInt(input.requiredConfirmations)) {
    return {kind: 'pending', reason: 'awaiting_confirmations'}
  }
  return {kind: 'confirmed'}
}

const ALLOWED: Record<ChainTransactionStatus, ChainTransactionStatus[]> = {
  pending: ['pending', 'confirmed', 'failed', 'reorged'],
  // A confirmed transaction can still be reorged out; nothing else is allowed.
  confirmed: ['confirmed', 'reorged'],
  // A reorged transaction may be re-included in a new block.
  reorged: ['reorged', 'pending', 'confirmed', 'failed'],
  failed: ['failed'],
}

/**
 * Maps a verdict onto the stored transaction status, refusing impossible
 * transitions (for example resurrecting a failed transaction).
 */
export function nextTransactionStatus(
  current: ChainTransactionStatus,
  verdict: TxVerdict,
): ChainTransactionStatus {
  const target: ChainTransactionStatus =
    verdict.kind === 'pending' ? 'pending' : verdict.kind
  if (!ALLOWED[current].includes(target)) {
    throw new Error(`illegal transaction status change ${current} -> ${target}`)
  }
  return target
}
