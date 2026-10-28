import {describe, expect, it} from '@jest/globals'

import {Web3ApiError} from '#/features/web3/api/client'
import {type PreparedTransfer, type Tip} from '#/features/web3/api/types'
import {describeTip, isFinalTip} from '#/features/web3/tip/describe'
import {
  mapTipError,
  newIdempotencyKey,
  payTip,
  submitSentTransaction,
  TipError,
} from '#/features/web3/tip/payTip'
import {WalletError} from '#/features/web3/wallet/types'

const HASH = `0x${'ab'.repeat(32)}` as const
const transfer: PreparedTransfer = {
  chainId: 84532,
  to: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  data: '0xa9059cbb',
  value: '0',
}
const tip = (over: Partial<Tip> = {}): Tip => ({
  id: 'tip-1',
  status: 'created',
  chainId: 84532,
  senderDid: 'did:plc:a',
  recipientDid: 'did:plc:b',
  senderAddress: '0x1',
  recipientAddress: '0x2',
  token: {address: transfer.to, symbol: 'USDC', decimals: 6},
  amountUnits: '1500000',
  amount: '1.5',
  postUri: null,
  expiresAt: 'x',
  createdAt: 'x',
  requiredConfirmations: 5,
  transaction: null,
  ...over,
})

const input = {
  recipientDid: 'did:plc:b',
  chainId: 84532,
  amount: '1.5',
  senderAddress: '0x1',
}

function harness(
  over: {
    create?: () => Promise<{tip: Tip; transfer: PreparedTransfer}>
    send?: () => Promise<`0x${string}`>
    submit?: () => Promise<Tip>
  } = {},
) {
  const log: string[] = []
  const sent: PreparedTransfer[] = []
  return {
    log,
    sent,
    deps: {
      api: {
        createTipIntent: () => {
          log.push('create')
          return (
            over.create ?? (() => Promise.resolve({tip: tip(), transfer}))
          )()
        },
        submitTipTransaction: () => {
          log.push('submit')
          return (
            over.submit ??
            (() => Promise.resolve(tip({status: 'awaiting_confirmation'})))
          )()
        },
      },
      wallet: {
        sendTransaction: (t: PreparedTransfer) => {
          log.push('send')
          sent.push(t)
          return (over.send ?? (() => Promise.resolve(HASH)))()
        },
      },
      input,
      idempotencyKey: 'key-0123456789',
    },
  }
}

describe('payTip', () => {
  it("creates the intent first, then sends the SERVICE's transfer, then reports the hash", async () => {
    const h = harness()
    const res = await payTip(h.deps)
    expect(h.log).toEqual(['create', 'send', 'submit'])
    expect(h.sent).toEqual([transfer])
    expect(res.txHash).toBe(HASH)
    // The best a send can achieve is "awaiting confirmation", never "paid".
    expect(res.tip.status).toBe('awaiting_confirmation')
  })

  it('does not ask the wallet to send if the intent could not be created', async () => {
    const h = harness({
      create: () =>
        Promise.reject(new Web3ApiError(422, 'recipient_not_tippable', 'm')),
    })
    await expect(payTip(h.deps)).rejects.toMatchObject({
      reason: 'recipient_not_tippable',
    })
    expect(h.log).toEqual(['create'])
  })

  it('does not report anything when the wallet rejects', async () => {
    const h = harness({send: () => Promise.reject(new WalletError('rejected'))})
    await expect(payTip(h.deps)).rejects.toMatchObject({
      reason: 'wallet_rejected',
      tipId: 'tip-1',
    })
    expect(h.log).toEqual(['create', 'send'])
  })

  it('refuses to send on the wrong network (the wallet layer says so)', async () => {
    const h = harness({
      send: () => Promise.reject(new WalletError('wrong_network')),
    })
    await expect(payTip(h.deps)).rejects.toMatchObject({
      reason: 'wrong_network',
    })
    expect(h.log).not.toContain('submit')
  })

  it('keeps the hash when reporting fails, so only the report is retried', async () => {
    const h = harness({submit: () => Promise.reject(new Error('network down'))})
    const err = await payTip(h.deps).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TipError)
    expect(err).toMatchObject({
      reason: 'unavailable',
      tipId: 'tip-1',
      txHash: HASH,
    })
    expect(h.log).toEqual(['create', 'send', 'submit'])

    // Retrying reports again and NEVER sends again.
    const retry = harness()
    await submitSentTransaction(retry.deps.api, 'tip-1', HASH)
    expect(retry.log).toEqual(['submit'])
  })

  it('passes the same idempotency key through, so retries create at most one intent', async () => {
    let seen = ''
    const h = harness()
    h.deps.api.createTipIntent = ((i: {idempotencyKey: string}) => {
      seen = i.idempotencyKey
      return Promise.resolve({tip: tip(), transfer})
    }) as never
    await payTip(h.deps)
    expect(seen).toBe('key-0123456789')
  })

  it('reports the stage order for the UI', async () => {
    const stages: string[] = []
    await payTip({...harness().deps, onStage: s => stages.push(s)})
    expect(stages).toEqual(['creating', 'awaiting_wallet', 'reporting'])
  })
})

describe('mapTipError', () => {
  it.each([
    [new WalletError('rejected'), 'wallet_rejected'],
    [new WalletError('wrong_network'), 'wrong_network'],
    [new WalletError('not_connected'), 'not_connected'],
    [
      new Web3ApiError(422, 'sender_wallet_not_linked', ''),
      'sender_wallet_not_linked',
    ],
    [new Web3ApiError(422, 'amount_too_small', ''), 'amount_invalid'],
    [new Web3ApiError(422, 'tipping_unavailable', ''), 'tipping_unavailable'],
    [new Web3ApiError(429, 'rate_limited', ''), 'rate_limited'],
    [new Web3ApiError(503, 'x', ''), 'unavailable'],
    [new Error('secret'), 'unknown'],
  ])('maps %#', (e, expected) => {
    expect(mapTipError(e)).toBe(expected)
  })
})

describe('describeTip (status comes only from the service)', () => {
  it('is confirmed only when the service says confirmed', () => {
    expect(describeTip(tip({status: 'confirmed'})).kind).toBe('confirmed')
  })

  it('a submitted transaction is pending, never confirmed', () => {
    const v = describeTip(
      tip({
        status: 'awaiting_confirmation',
        transaction: {
          hash: HASH,
          status: 'pending',
          blockNumber: null,
          confirmations: null,
          explorerUrl: 'u',
        },
      }),
    )
    expect(v.kind).toBe('pending')
  })

  it('an intent with no transaction is "not sent"', () => {
    expect(describeTip(tip({status: 'created'})).kind).toBe('not_sent')
  })

  it('maps failure states and finality', () => {
    expect(describeTip(tip({status: 'failed'})).kind).toBe('failed')
    expect(describeTip(tip({status: 'expired'})).kind).toBe('expired')
    expect(describeTip(tip({status: 'reorged'})).kind).toBe('reorged')
    expect(isFinalTip(tip({status: 'confirmed'}))).toBe(true)
    expect(isFinalTip(tip({status: 'failed'}))).toBe(true)
    // A reorged payment may still change, so polling continues.
    expect(isFinalTip(tip({status: 'reorged'}))).toBe(false)
    expect(isFinalTip(tip({status: 'awaiting_confirmation'}))).toBe(false)
  })
})

describe('newIdempotencyKey', () => {
  it('is unpredictable and matches the server format', () => {
    const a = newIdempotencyKey()
    const b = newIdempotencyKey()
    expect(a).toMatch(/^[0-9a-f]{36}$/)
    expect(a).not.toBe(b)
  })
})
