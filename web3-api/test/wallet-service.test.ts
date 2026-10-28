import {privateKeyToAccount} from 'viem/accounts'
import {describe, expect, it} from 'vitest'

import {AppError} from '../src/errors.ts'
import {WalletLinkService} from '../src/wallet/service.ts'
import {EoaSignatureVerifier} from '../src/wallet/signature-verifier.ts'
import {
  ALICE,
  BOB,
  makeService,
  newWallet,
  testConfig,
} from './helpers/fixtures.ts'
import {MemoryWalletRepository} from './helpers/memory-wallet-repo.ts'

const CHAIN = 84532

async function rejectsWith(p: Promise<unknown>, code: string, status?: number) {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    expect((e as AppError).code).toBe(code)
    if (status) expect((e as AppError).statusCode).toBe(status)
    return
  }
  expect.unreachable(`expected rejection with ${code}`)
}

async function challengeFor(
  service: WalletLinkService,
  did: string,
  address: string,
) {
  return service.createChallenge(did, {address, chainId: CHAIN})
}

describe('wallet linking: happy path', () => {
  it('links a wallet after a valid signature', async () => {
    const {service} = makeService()
    const wallet = newWallet()
    const ch = await challengeFor(service, ALICE, wallet.address)

    // The message binds domain, chain, DID and an expiry.
    expect(ch.message).toContain('localhost:19006 wants you to sign in')
    expect(ch.message).toContain(`Chain ID: ${CHAIN}`)
    expect(ch.message).toContain(ALICE)
    expect(ch.message).toContain('Expiration Time:')

    const signature = await wallet.signMessage({message: ch.message})
    const res = await service.verifyChallenge(ALICE, {
      challengeId: ch.challengeId,
      signature,
    })
    expect(res.created).toBe(true)
    expect(res.wallet).toMatchObject({chainId: CHAIN, address: wallet.address})
    expect(await service.listWallets(ALICE)).toHaveLength(1)
    expect(await service.listWallets(BOB)).toHaveLength(0)
  })

  it('stores only a hash of the nonce, never the nonce itself', async () => {
    const {service, repo} = makeService()
    const wallet = newWallet()
    const ch = await challengeFor(service, ALICE, wallet.address)
    const row = [...repo.challenges.values()][0]!
    const nonce = /Nonce: (\S+)/.exec(ch.message)![1]!
    expect(row.nonceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.nonceHash).not.toContain(nonce)
  })
})

describe('wallet linking: replay and reuse', () => {
  it('rejects replaying the same signed challenge', async () => {
    const {service} = makeService()
    const wallet = newWallet()
    const ch = await challengeFor(service, ALICE, wallet.address)
    const signature = await wallet.signMessage({message: ch.message})
    const input = {challengeId: ch.challengeId, signature}

    await service.verifyChallenge(ALICE, input)
    await rejectsWith(
      service.verifyChallenge(ALICE, input),
      'invalid_or_expired_challenge',
      400,
    )
  })

  it('burns the challenge even when the signature is wrong', async () => {
    const {service} = makeService()
    const wallet = newWallet()
    const attacker = newWallet()
    const ch = await challengeFor(service, ALICE, wallet.address)

    const bad = await attacker.signMessage({message: ch.message})
    await rejectsWith(
      service.verifyChallenge(ALICE, {
        challengeId: ch.challengeId,
        signature: bad,
      }),
      'invalid_signature',
    )
    // The right signature no longer works either: a fresh challenge is needed.
    const good = await wallet.signMessage({message: ch.message})
    await rejectsWith(
      service.verifyChallenge(ALICE, {
        challengeId: ch.challengeId,
        signature: good,
      }),
      'invalid_or_expired_challenge',
    )
    expect(await service.listWallets(ALICE)).toHaveLength(0)
  })

  it('lets only one of many concurrent verifications succeed', async () => {
    const {service} = makeService()
    const wallet = newWallet()
    const ch = await challengeFor(service, ALICE, wallet.address)
    const signature = await wallet.signMessage({message: ch.message})
    const results = await Promise.allSettled(
      Array.from({length: 8}, () =>
        service.verifyChallenge(ALICE, {
          challengeId: ch.challengeId,
          signature,
        }),
      ),
    )
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('supersedes an earlier live challenge for the same DID and wallet', async () => {
    const {service} = makeService()
    const wallet = newWallet()
    const first = await challengeFor(service, ALICE, wallet.address)
    const second = await challengeFor(service, ALICE, wallet.address)
    expect(second.challengeId).not.toBe(first.challengeId)

    const sig1 = await wallet.signMessage({message: first.message})
    await rejectsWith(
      service.verifyChallenge(ALICE, {
        challengeId: first.challengeId,
        signature: sig1,
      }),
      'invalid_or_expired_challenge',
    )
    const sig2 = await wallet.signMessage({message: second.message})
    const ok = await service.verifyChallenge(ALICE, {
      challengeId: second.challengeId,
      signature: sig2,
    })
    expect(ok.created).toBe(true)
  })
})

describe('wallet linking: binding', () => {
  it('rejects a signature from a different wallet', async () => {
    const {service} = makeService()
    const claimed = newWallet()
    const other = newWallet()
    const ch = await challengeFor(service, ALICE, claimed.address)
    const signature = await other.signMessage({message: ch.message})
    await rejectsWith(
      service.verifyChallenge(ALICE, {challengeId: ch.challengeId, signature}),
      'invalid_signature',
    )
  })

  it("rejects another DID presenting someone else's challenge", async () => {
    const {service} = makeService()
    const wallet = newWallet()
    const ch = await challengeFor(service, ALICE, wallet.address)
    const signature = await wallet.signMessage({message: ch.message})
    await rejectsWith(
      service.verifyChallenge(BOB, {challengeId: ch.challengeId, signature}),
      'invalid_or_expired_challenge',
    )
    // Alice's challenge was not consumed by Bob's failed attempt.
    const ok = await service.verifyChallenge(ALICE, {
      challengeId: ch.challengeId,
      signature,
    })
    expect(ok.created).toBe(true)
  })

  it('rejects an expired challenge', async () => {
    let now = new Date('2026-11-01T12:00:00Z')
    const {service} = makeService(() => now)
    const wallet = newWallet()
    const ch = await challengeFor(service, ALICE, wallet.address)
    const signature = await wallet.signMessage({message: ch.message})
    now = new Date(
      now.getTime() + (testConfig().WALLET_CHALLENGE_TTL_SECONDS + 1) * 1000,
    )
    await rejectsWith(
      service.verifyChallenge(ALICE, {challengeId: ch.challengeId, signature}),
      'invalid_or_expired_challenge',
    )
  })

  it('rejects a challenge whose stored message does not match the domain', async () => {
    const repo = new MemoryWalletRepository()
    const issuer = new WalletLinkService(
      repo,
      new EoaSignatureVerifier(),
      testConfig(),
    )
    const wallet = newWallet()
    const ch = await issuer.createChallenge(ALICE, {
      address: wallet.address,
      chainId: CHAIN,
    })
    const signature = await wallet.signMessage({message: ch.message})
    // A verifier configured for a different domain must not accept it.
    const other = new WalletLinkService(repo, new EoaSignatureVerifier(), {
      ...testConfig(),
      SIWE_DOMAIN: 'evil.example',
    })
    await rejectsWith(
      other.verifyChallenge(ALICE, {challengeId: ch.challengeId, signature}),
      'invalid_or_expired_challenge',
    )
  })

  it('rejects unsupported chains and malformed addresses', async () => {
    const {service} = makeService()
    const wallet = newWallet()
    await rejectsWith(
      service.createChallenge(ALICE, {address: wallet.address, chainId: 1}),
      'unsupported_chain',
      422,
    )
    await rejectsWith(
      service.createChallenge(ALICE, {address: '0xnope', chainId: CHAIN}),
      'invalid_address',
      400,
    )
  })

  it('does not accept contract-wallet signatures yet', async () => {
    const {service} = makeService()
    const wallet = newWallet()
    const ch = await challengeFor(service, ALICE, wallet.address)
    await rejectsWith(
      service.verifyChallenge(ALICE, {
        challengeId: ch.challengeId,
        signature: `0x${'ab'.repeat(200)}`,
      }),
      'unsupported_signature_type',
      422,
    )
  })
})

describe('wallet linking: no unauthorised reassignment', () => {
  it('refuses to issue a challenge for a wallet linked to another DID', async () => {
    const {service} = makeService()
    const wallet = newWallet()
    const ch = await challengeFor(service, ALICE, wallet.address)
    await service.verifyChallenge(ALICE, {
      challengeId: ch.challengeId,
      signature: await wallet.signMessage({message: ch.message}),
    })
    await rejectsWith(
      challengeFor(service, BOB, wallet.address),
      'wallet_already_linked',
      409,
    )
    await rejectsWith(
      challengeFor(service, ALICE, wallet.address),
      'already_linked',
      409,
    )
  })

  it('refuses when two DIDs race for the same wallet', async () => {
    const {service} = makeService()
    const wallet = newWallet()
    // Both challenges are issued before either is verified.
    const a = await challengeFor(service, ALICE, wallet.address)
    const b = await challengeFor(service, BOB, wallet.address)
    const [sa, sb] = await Promise.all([
      wallet.signMessage({message: a.message}),
      wallet.signMessage({message: b.message}),
    ])
    const first = await service.verifyChallenge(ALICE, {
      challengeId: a.challengeId,
      signature: sa,
    })
    expect(first.created).toBe(true)
    await rejectsWith(
      service.verifyChallenge(BOB, {challengeId: b.challengeId, signature: sb}),
      'wallet_already_linked',
      409,
    )
    expect(await service.listWallets(BOB)).toHaveLength(0)
  })

  it('treats the same wallet in a different case as the same wallet', async () => {
    const {service} = makeService()
    const wallet = newWallet()
    const ch = await challengeFor(service, ALICE, wallet.address)
    await service.verifyChallenge(ALICE, {
      challengeId: ch.challengeId,
      signature: await wallet.signMessage({message: ch.message}),
    })
    await rejectsWith(
      challengeFor(service, BOB, wallet.address.toLowerCase()),
      'wallet_already_linked',
    )
  })
})

describe('test fixtures', () => {
  it('generate fresh keys every time', () => {
    expect(newWallet().address).not.toBe(newWallet().address)
    expect(privateKeyToAccount).toBeTypeOf('function')
  })
})
