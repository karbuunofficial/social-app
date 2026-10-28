import {
  type Address,
  encodeAbiParameters,
  getAddress,
  type Hex,
  keccak256,
  pad,
  toHex,
} from 'viem'
import {describe, expect, it} from 'vitest'

import {
  buildChainConfigs,
  requireUsdcAddress,
  UsdcNotConfiguredError,
} from '../src/payments/chains.ts'
import {
  ERC20_TRANSFER_TOPIC,
  prepareUsdcTransfer,
} from '../src/payments/erc20.ts'
import {
  type ChainReceipt,
  evaluateTransaction,
  hasMatchingTransfer,
  nextTransactionStatus,
} from '../src/payments/receipt.ts'

const TOKEN = getAddress('0x2222222222222222222222222222222222222222')
const FROM = getAddress('0x3333333333333333333333333333333333333333')
const TO = getAddress('0x4444444444444444444444444444444444444444')
const AMOUNT = 5_000_000n
/** Typed as Hex by viem, so no casts are needed. */
const HASH_A = keccak256(toHex('block-a'))
const HASH_B = keccak256(toHex('block-b'))

const expected = {token: TOKEN, from: FROM, to: TO, amount: AMOUNT}

const transferLog = (o: {
  token?: Address
  from?: Address
  to?: Address
  amount?: bigint
}) => ({
  address: o.token ?? TOKEN,
  topics: [ERC20_TRANSFER_TOPIC, pad(o.from ?? FROM), pad(o.to ?? TO)] as Hex[],
  data: encodeAbiParameters([{type: 'uint256'}], [o.amount ?? AMOUNT]),
})

const receipt = (over: Partial<ChainReceipt> = {}): ChainReceipt => ({
  status: 'success',
  blockNumber: 100n,
  blockHash: HASH_A,
  logs: [transferLog({})],
  ...over,
})

const verdict = (
  r: ChainReceipt | null,
  head: bigint,
  previousBlockHash?: Hex | null,
) =>
  evaluateTransaction({
    expected,
    receipt: r,
    head,
    requiredConfirmations: 5,
    previousBlockHash,
  })

describe('hasMatchingTransfer', () => {
  it('accepts an exact match', () => {
    expect(hasMatchingTransfer(receipt(), expected)).toBe(true)
  })

  it.each([
    ['wrong token contract', {token: getAddress(`0x${'9'.repeat(40)}`)}],
    ['wrong sender', {from: getAddress(`0x${'8'.repeat(40)}`)}],
    ['wrong recipient', {to: getAddress(`0x${'7'.repeat(40)}`)}],
    ['underpayment', {amount: AMOUNT - 1n}],
    ['overpayment', {amount: AMOUNT + 1n}],
  ])('rejects %s', (_name, override) => {
    expect(
      hasMatchingTransfer(receipt({logs: [transferLog(override)]}), expected),
    ).toBe(false)
  })

  it('rejects when the same transfer appears twice (ambiguous)', () => {
    expect(
      hasMatchingTransfer(
        receipt({logs: [transferLog({}), transferLog({})]}),
        expected,
      ),
    ).toBe(false)
  })

  it('ignores unrelated and malformed logs', () => {
    const noise = {address: TOKEN, topics: [HASH_B] as Hex[], data: '0x' as Hex}
    expect(
      hasMatchingTransfer(receipt({logs: [noise, transferLog({})]}), expected),
    ).toBe(true)
    expect(
      hasMatchingTransfer(
        receipt({logs: [{...transferLog({}), data: toHex(1n)}]}),
        expected,
      ),
    ).toBe(false)
  })
})

describe('evaluateTransaction', () => {
  it('is pending when the node does not know the transaction', () => {
    expect(verdict(null, 200n)).toEqual({kind: 'pending', reason: 'not_found'})
  })

  it('is pending until enough confirmations', () => {
    // block 100, head 103 => 4 confirmations (< 5)
    expect(verdict(receipt(), 103n)).toEqual({
      kind: 'pending',
      reason: 'awaiting_confirmations',
    })
    // head 104 => 5 confirmations
    expect(verdict(receipt(), 104n)).toEqual({kind: 'confirmed'})
  })

  it('fails reverted transactions and non-matching ones', () => {
    expect(verdict(receipt({status: 'reverted'}), 500n)).toEqual({
      kind: 'failed',
      reason: 'reverted',
    })
    expect(verdict(receipt({logs: []}), 500n)).toEqual({
      kind: 'failed',
      reason: 'no_matching_transfer',
    })
  })

  it('detects a reorg when the block hash changes', () => {
    expect(verdict(receipt({blockHash: HASH_B}), 500n, HASH_A)).toEqual({
      kind: 'reorged',
    })
  })

  it('detects a reorg when a previously seen receipt disappears', () => {
    expect(verdict(null, 500n, HASH_A)).toEqual({kind: 'reorged'})
  })

  it('stays confirmed when the block hash is unchanged', () => {
    expect(verdict(receipt(), 500n, HASH_A)).toEqual({kind: 'confirmed'})
  })
})

describe('nextTransactionStatus', () => {
  it('allows the normal lifecycle', () => {
    expect(nextTransactionStatus('pending', {kind: 'confirmed'})).toBe(
      'confirmed',
    )
    expect(
      nextTransactionStatus('pending', {kind: 'pending', reason: 'not_found'}),
    ).toBe('pending')
    expect(nextTransactionStatus('confirmed', {kind: 'reorged'})).toBe(
      'reorged',
    )
    expect(
      nextTransactionStatus('reorged', {
        kind: 'pending',
        reason: 'awaiting_confirmations',
      }),
    ).toBe('pending')
  })

  it('refuses impossible transitions', () => {
    expect(() => nextTransactionStatus('failed', {kind: 'confirmed'})).toThrow(
      /illegal/,
    )
    expect(() =>
      nextTransactionStatus('confirmed', {kind: 'failed', reason: 'reverted'}),
    ).toThrow(/illegal/)
    expect(() =>
      nextTransactionStatus('confirmed', {
        kind: 'pending',
        reason: 'not_found',
      }),
    ).toThrow(/illegal/)
  })
})

describe('chain config and transfer preparation', () => {
  const cfg = (usdc: Record<number, string>) =>
    buildChainConfigs({ALLOWED_CHAIN_IDS: [84532, 8453], USDC_ADDRESSES: usdc})

  it('refuses to prepare a transfer without a configured token address', () => {
    const chain = cfg({}).get(84532)!
    expect(chain.usdcAddress).toBeUndefined()
    expect(() => requireUsdcAddress(chain)).toThrow(UsdcNotConfiguredError)
    expect(() =>
      prepareUsdcTransfer({chain, recipient: TO, amount: 1n}),
    ).toThrow(UsdcNotConfiguredError)
  })

  it('rejects unknown chains', () => {
    expect(() =>
      buildChainConfigs({ALLOWED_CHAIN_IDS: [1], USDC_ADDRESSES: {}}),
    ).toThrow(/Unsupported chain/)
  })

  it('prepares an unsigned ERC-20 transfer with zero native value', () => {
    const chain = cfg({84532: TOKEN}).get(84532)!
    const tx = prepareUsdcTransfer({chain, recipient: TO, amount: AMOUNT})
    expect(tx).toMatchObject({chainId: 84532, to: TOKEN, value: '0'})
    // transfer(address,uint256) selector, recipient, amount.
    expect(tx.data.slice(0, 10)).toBe('0xa9059cbb')
    expect(tx.data.toLowerCase()).toContain(TO.slice(2).toLowerCase())
    expect(BigInt(`0x${tx.data.slice(-64)}`)).toBe(AMOUNT)
    expect(() =>
      prepareUsdcTransfer({chain, recipient: TO, amount: 0n}),
    ).toThrow(RangeError)
  })
})
