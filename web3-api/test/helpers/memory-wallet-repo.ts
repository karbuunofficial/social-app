import {randomUUID} from 'node:crypto'

import {
  type NewChallenge,
  type UserWallet,
  type WalletChallenge,
  type WalletRepository,
} from '../../src/wallet/types.ts'

/**
 * In-memory WalletRepository for unit tests. `consumeChallenge` is synchronous
 * between check and write, so it is atomic like the SQL version.
 */
export class MemoryWalletRepository implements WalletRepository {
  challenges = new Map<string, WalletChallenge>()
  links: UserWallet[] = []

  withTransaction<T>(fn: (repo: WalletRepository) => Promise<T>): Promise<T> {
    return fn(this)
  }

  findLinkByAddress(chainId: number, address: string) {
    return Promise.resolve(
      this.links.find(l => l.chainId === chainId && l.address === address) ??
        null,
    )
  }

  listLinksForDid(did: string) {
    return Promise.resolve(this.links.filter(l => l.did === did))
  }

  supersedeLiveChallenges(did: string, address: string, now: Date) {
    for (const c of this.challenges.values()) {
      if (c.did === did && c.address === address && !c.consumedAt) {
        c.consumedAt = now
      }
    }
    return Promise.resolve()
  }

  insertChallenge(c: NewChallenge) {
    const row: WalletChallenge = {...c, id: randomUUID(), consumedAt: null}
    this.challenges.set(row.id, row)
    return Promise.resolve(row)
  }

  consumeChallenge(id: string, did: string, now: Date) {
    const c = this.challenges.get(id)
    if (!c || c.did !== did || c.consumedAt || c.expiresAt <= now) {
      return Promise.resolve(null)
    }
    c.consumedAt = now
    return Promise.resolve({...c})
  }

  insertLink(link: {
    did: string
    chainId: number
    address: string
    verifiedAt: Date
  }) {
    const existing = this.links.find(
      l => l.chainId === link.chainId && l.address === link.address,
    )
    if (existing) return Promise.resolve({wallet: existing, created: false})
    const wallet: UserWallet = {
      id: randomUUID(),
      createdAt: link.verifiedAt,
      ...link,
    }
    this.links.push(wallet)
    return Promise.resolve({wallet, created: true})
  }
}
