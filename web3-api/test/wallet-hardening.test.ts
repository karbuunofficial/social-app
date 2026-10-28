import {describe, expect, it} from 'vitest'

import {MemoryAuditLog} from '../src/audit.ts'
import {AppError, serviceUnavailable} from '../src/errors.ts'
import {WalletLinkService} from '../src/wallet/service.ts'
import {type WalletSignatureVerifier} from '../src/wallet/signature-verifier.ts'
import {EoaSignatureVerifier} from '../src/wallet/signature-verifier.ts'
import {ALICE, BOB, newWallet, testConfig} from './helpers/fixtures.ts'
import {MemoryWalletRepository} from './helpers/memory-wallet-repo.ts'

const CHAIN = 84532

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    return (e as AppError).code
  }
  return 'NO_ERROR'
}

function setup(
  over: Partial<ReturnType<typeof testConfig>> = {},
  verifier?: WalletSignatureVerifier,
) {
  let now = new Date('2026-11-01T12:00:00Z')
  const repo = new MemoryWalletRepository()
  const audit = new MemoryAuditLog()
  const service = new WalletLinkService(
    repo,
    verifier ?? new EoaSignatureVerifier(),
    {...testConfig(), ...over},
    () => now,
    audit,
  )
  return {
    repo,
    audit,
    service,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    now: () => now,
  }
}

async function link(
  service: WalletLinkService,
  did: string,
  wallet = newWallet(),
) {
  const ch = await service.createChallenge(did, {
    address: wallet.address,
    chainId: CHAIN,
  })
  const signature = await wallet.signMessage({message: ch.message})
  const res = await service.verifyChallenge(did, {
    challengeId: ch.challengeId,
    signature,
  })
  return {wallet, res}
}

describe('unlinking', () => {
  it('lets the owner unlink, and removes the wallet from the list', async () => {
    const {service, repo} = setup()
    const {res} = await link(service, ALICE)
    expect(await service.listWallets(ALICE)).toHaveLength(1)
    const out = await service.unlinkWallet(ALICE, res.wallet.id)
    expect(out.id).toBe(res.wallet.id)
    expect(await service.listWallets(ALICE)).toHaveLength(0)
    // History is retained (revoked, not deleted).
    expect(repo.links).toHaveLength(1)
    expect(repo.links[0]!.revokedAt).not.toBeNull()
  })

  it("never lets another DID unlink someone's wallet, and does not reveal it exists", async () => {
    const {service} = setup()
    const {res} = await link(service, ALICE)
    expect(await code(service.unlinkWallet(BOB, res.wallet.id))).toBe(
      'wallet_not_found',
    )
    expect(await code(service.unlinkWallet(BOB, crypto.randomUUID()))).toBe(
      'wallet_not_found',
    )
    expect(await service.listWallets(ALICE)).toHaveLength(1)
  })

  it('cannot unlink twice', async () => {
    const {service} = setup()
    const {res} = await link(service, ALICE)
    await service.unlinkWallet(ALICE, res.wallet.id)
    expect(await code(service.unlinkWallet(ALICE, res.wallet.id))).toBe(
      'wallet_not_found',
    )
  })

  it('refuses while a payment involving the wallet is in flight', async () => {
    const {service, repo} = setup()
    const {res} = await link(service, ALICE)
    repo.openPayments.add(`${CHAIN}:${res.wallet.address.toLowerCase()}`)
    expect(await code(service.unlinkWallet(ALICE, res.wallet.id))).toBe(
      'open_payments',
    )
    expect(await service.listWallets(ALICE)).toHaveLength(1)
    repo.openPayments.clear()
    await service.unlinkWallet(ALICE, res.wallet.id)
  })

  it('lets the same account relink its own wallet immediately', async () => {
    const {service} = setup()
    const {wallet, res} = await link(service, ALICE)
    await service.unlinkWallet(ALICE, res.wallet.id)
    const again = await link(service, ALICE, wallet)
    expect(again.res.created).toBe(true)
  })

  it('holds a released wallet against another account for the cool-down, then frees it', async () => {
    const {service, advance} = setup({WALLET_RELINK_COOLDOWN_SECONDS: 3600})
    const {wallet, res} = await link(service, ALICE)
    await service.unlinkWallet(ALICE, res.wallet.id)

    const attempt = () =>
      service.createChallenge(BOB, {address: wallet.address, chainId: CHAIN})
    expect(await code(attempt())).toBe('wallet_recently_released')
    advance(3601 * 1000)
    // After the cool-down Bob can start; he still needs the wallet's signature.
    const ch = await attempt()
    const sig = await wallet.signMessage({message: ch.message})
    const ok = await service.verifyChallenge(BOB, {
      challengeId: ch.challengeId,
      signature: sig,
    })
    expect(ok.created).toBe(true)
  })

  it('writes audit events for link and unlink, without secrets', async () => {
    const {service, audit} = setup()
    const {res} = await link(service, ALICE)
    await service.unlinkWallet(ALICE, res.wallet.id, {requestId: 'req-7'})
    const actions = audit.events.map(e => `${e.action}:${e.outcome}`)
    expect(actions).toContain('wallet.challenge.create:success')
    expect(actions).toContain('wallet.link:success')
    expect(actions).toContain('wallet.unlink:success')
    const dump = JSON.stringify(audit.events)
    expect(dump).not.toMatch(/0x[0-9a-f]{130}/i) // no signatures
    expect(dump).not.toContain('Nonce')
    expect(
      audit.events.find(e => e.action === 'wallet.unlink')?.requestId,
    ).toBe('req-7')
  })

  it('audits denied attempts with a reason', async () => {
    const {service, audit} = setup()
    await code(service.unlinkWallet(BOB, crypto.randomUUID()))
    expect(audit.events.at(-1)).toMatchObject({
      action: 'wallet.unlink',
      actorDid: BOB,
      outcome: 'denied',
      reason: 'wallet_not_found',
    })
  })
})

describe('quotas', () => {
  it('limits how many challenges one DID can create per hour, from the database', async () => {
    const {service, advance} = setup({WALLET_CHALLENGES_PER_HOUR: 3})
    for (let i = 0; i < 3; i++) {
      await service.createChallenge(ALICE, {
        address: newWallet().address,
        chainId: CHAIN,
      })
    }
    expect(
      await code(
        service.createChallenge(ALICE, {
          address: newWallet().address,
          chainId: CHAIN,
        }),
      ),
    ).toBe('rate_limited')
    // Another DID is unaffected.
    await service.createChallenge(BOB, {
      address: newWallet().address,
      chainId: CHAIN,
    })
    // The window slides.
    advance(3_600_001)
    await service.createChallenge(ALICE, {
      address: newWallet().address,
      chainId: CHAIN,
    })
  })
})

describe('infrastructure failures', () => {
  const flaky = (failures: {n: number}): WalletSignatureVerifier => {
    const real = new EoaSignatureVerifier()
    return {
      verify: p => {
        if (failures.n-- > 0) {
          return Promise.reject(
            serviceUnavailable('verification_unavailable', 'rpc down'),
          )
        }
        return real.verify(p)
      },
    }
  }

  it('re-opens the challenge when verification could not run, so the user can retry', async () => {
    const failures = {n: 1}
    const {service} = setup({}, flaky(failures))
    const wallet = newWallet()
    const ch = await service.createChallenge(ALICE, {
      address: wallet.address,
      chainId: CHAIN,
    })
    const signature = await wallet.signMessage({message: ch.message})

    expect(
      await code(
        service.verifyChallenge(ALICE, {
          challengeId: ch.challengeId,
          signature,
        }),
      ),
    ).toBe('verification_unavailable')
    // Same challenge, same signature: works once the infrastructure recovers.
    const ok = await service.verifyChallenge(ALICE, {
      challengeId: ch.challengeId,
      signature,
    })
    expect(ok.created).toBe(true)
  })

  it('still burns the challenge when the signature itself is wrong', async () => {
    const {service} = setup()
    const wallet = newWallet()
    const ch = await service.createChallenge(ALICE, {
      address: wallet.address,
      chainId: CHAIN,
    })
    const bad = await newWallet().signMessage({message: ch.message})
    expect(
      await code(
        service.verifyChallenge(ALICE, {
          challengeId: ch.challengeId,
          signature: bad,
        }),
      ),
    ).toBe('invalid_signature')
    const good = await wallet.signMessage({message: ch.message})
    expect(
      await code(
        service.verifyChallenge(ALICE, {
          challengeId: ch.challengeId,
          signature: good,
        }),
      ),
    ).toBe('invalid_or_expired_challenge')
  })
})
