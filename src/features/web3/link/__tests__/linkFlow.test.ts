import {describe, expect, it} from '@jest/globals'

import {Web3ApiError} from '#/features/web3/api/client'
import {type LinkedWallet} from '#/features/web3/api/types'
import {
  assertSafeChallenge,
  LinkError,
  type LinkStage,
  linkWallet,
} from '#/features/web3/link/linkFlow'
import {WalletError} from '#/features/web3/wallet/types'

const DID = 'did:plc:alice1234567890abcdefgh'
const ADDRESS = '0x9aA1D5e0Bb7B8C0F36a2F9c1E4d3B2A1C0dE5f66'
const HOST = 'localhost:19006'
const SIG = `0x${'cd'.repeat(65)}` as const

const message = (
  over: Partial<Record<'host' | 'address' | 'chain' | 'did', string>> = {},
) =>
  [
    `${over.host ?? HOST} wants you to sign in with your Ethereum account:`,
    over.address ?? ADDRESS,
    '',
    'Link this wallet to your account. Signing this message does not send a transaction or give anyone access to your funds.',
    '',
    `URI: http://${HOST}`,
    'Version: 1',
    `Chain ID: ${over.chain ?? '84532'}`,
    'Nonce: abc12345',
    'Issued At: 2026-11-01T12:00:00.000Z',
    'Expiration Time: 2026-11-01T12:05:00.000Z',
    'Resources:',
    `- ${over.did ?? DID}`,
  ].join('\n')

const expected = {address: ADDRESS, chainId: 84532, did: DID, host: HOST}

describe('assertSafeChallenge', () => {
  it('accepts exactly the requested sign-in', () => {
    expect(() => assertSafeChallenge(message(), expected)).not.toThrow()
    // Address case does not matter.
    expect(() =>
      assertSafeChallenge(message({address: ADDRESS.toLowerCase()}), expected),
    ).not.toThrow()
  })

  it.each([
    ['another website (phishing)', {host: 'evil.example'}],
    [
      'another wallet address',
      {address: '0x1111111111111111111111111111111111111111'},
    ],
    ['another chain', {chain: '1'}],
    ['another account', {did: 'did:plc:someoneelse000000000000'}],
  ])('refuses a challenge for %s', (_n, over) => {
    expect(() => assertSafeChallenge(message(over), expected)).toThrow(
      LinkError,
    )
    try {
      assertSafeChallenge(message(over), expected)
    } catch (e) {
      expect((e as LinkError).reason).toBe('unexpected_challenge')
    }
  })

  it('refuses a message that merely mentions the right values somewhere', () => {
    const sneaky = `evil.example wants you to sign in with your Ethereum account:\n0x1111111111111111111111111111111111111111\n\nChain ID: 84532\nResources:\n- ${DID}\n${ADDRESS} ${HOST}`
    expect(() => assertSafeChallenge(sneaky, expected)).toThrow(LinkError)
  })
})

function deps(over: Record<string, unknown> = {}) {
  const stages: LinkStage[] = []
  const signed: string[] = []
  const wallet: LinkedWallet = {
    id: 'w1',
    chainId: 84532,
    address: ADDRESS,
    verifiedAt: '2026-11-01T12:01:00Z',
  }
  const base = {
    api: {
      createChallenge: () =>
        Promise.resolve({
          challengeId: 'c1',
          message: message(),
          expiresAt: 'x',
        }),
      verifyChallenge: () => Promise.resolve({wallet}),
    },
    wallet: {
      signMessage: (m: string) => {
        signed.push(m)
        return Promise.resolve(SIG)
      },
    },
    address: ADDRESS,
    chainId: 84532,
    did: DID,
    host: HOST,
    onStage: (s: LinkStage) => stages.push(s),
  }
  return {
    d: {...base, ...over} as Parameters<typeof linkWallet>[0],
    stages,
    signed,
    wallet,
  }
}

describe('linkWallet', () => {
  it("runs challenge, signature, verification in order and returns the SERVER's wallet", async () => {
    const {d, stages, signed, wallet} = deps()
    await expect(linkWallet(d)).resolves.toEqual(wallet)
    expect(stages).toEqual([
      'requesting_challenge',
      'awaiting_signature',
      'verifying',
    ])
    expect(signed).toEqual([message()])
  })

  it('never asks the wallet to sign an unexpected challenge', async () => {
    const {d, signed} = deps({
      api: {
        createChallenge: () =>
          Promise.resolve({
            challengeId: 'c',
            message: message({host: 'evil.example'}),
            expiresAt: 'x',
          }),
        verifyChallenge: () => Promise.reject(new Error('must not be called')),
      },
    })
    await expect(linkWallet(d)).rejects.toMatchObject({
      reason: 'unexpected_challenge',
    })
    expect(signed).toEqual([])
  })

  it('does not call the server to verify when the user rejects signing', async () => {
    let verified = false
    const {d} = deps({
      wallet: {signMessage: () => Promise.reject(new WalletError('rejected'))},
      api: {
        createChallenge: () =>
          Promise.resolve({
            challengeId: 'c',
            message: message(),
            expiresAt: 'x',
          }),
        verifyChallenge: () => {
          verified = true
          return Promise.reject(new Error('no'))
        },
      },
    })
    await expect(linkWallet(d)).rejects.toMatchObject({reason: 'rejected'})
    expect(verified).toBe(false)
  })

  it.each([
    ['unsupported_signature_type', 422, 'unsupported_wallet_type'],
    ['wallet_already_linked', 409, 'wallet_taken'],
    ['already_linked', 409, 'already_linked'],
    ['wallet_recently_released', 409, 'recently_released'],
    ['invalid_or_expired_challenge', 400, 'challenge_expired'],
    ['invalid_signature', 400, 'invalid_signature'],
    ['rate_limited', 429, 'rate_limited'],
    ['verification_unavailable', 503, 'unavailable'],
  ])('maps server error %s to %s', async (code, status, reason) => {
    const {d} = deps({
      api: {
        createChallenge: () =>
          Promise.resolve({
            challengeId: 'c',
            message: message(),
            expiresAt: 'x',
          }),
        verifyChallenge: () =>
          Promise.reject(new Web3ApiError(status, code, 'm')),
      },
    })
    await expect(linkWallet(d)).rejects.toMatchObject({reason})
  })

  it('maps unknown failures without leaking their text', async () => {
    const {d} = deps({
      api: {
        createChallenge: () =>
          Promise.reject(new Error('secret internal detail')),
        verifyChallenge: () => Promise.reject(new Error('x')),
      },
    })
    const err: unknown = await linkWallet(d).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(LinkError)
    expect((err as LinkError).reason).toBe('unknown')
    expect((err as LinkError).message).not.toContain('secret')
  })
})
