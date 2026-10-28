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
  openPayments = new Set<string>()

  withTransaction<T>(fn: (repo: WalletRepository) => Promise<T>): Promise<T> {
    return fn(this)
  }

  findLinkByAddress(chainId: number, address: string) {
    return Promise.resolve(
      this.links.find(
        l => l.chainId === chainId && l.address === address && !l.revokedAt,
      ) ?? null,
    )
  }

  findRecentlyReleased(chainId: number, address: string, since: Date) {
    const rows = this.links
      .filter(
        l =>
          l.chainId === chainId &&
          l.address === address &&
          l.revokedAt &&
          l.revokedAt >= since,
      )
      .sort((a, b) => b.revokedAt!.getTime() - a.revokedAt!.getTime())
    return Promise.resolve(rows[0] ?? null)
  }

  listLinksForDid(did: string) {
    return Promise.resolve(
      this.links.filter(l => l.did === did && !l.revokedAt),
    )
  }

  getLinkById(id: string) {
    return Promise.resolve(this.links.find(l => l.id === id) ?? null)
  }

  revokeLink(id: string, did: string, now: Date) {
    const l = this.links.find(x => x.id === id && x.did === did && !x.revokedAt)
    if (!l) return Promise.resolve(null)
    l.revokedAt = now
    return Promise.resolve({...l})
  }

  hasOpenPayments(chainId: number, address: string) {
    return Promise.resolve(this.openPayments.has(`${chainId}:${address}`))
  }

  countChallengesSince(did: string, since: Date) {
    return Promise.resolve(
      [...this.challenges.values()].filter(
        c => c.did === did && c.createdAt >= since,
      ).length,
    )
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

  reopenChallenge(id: string) {
    const c = this.challenges.get(id)
    if (c) c.consumedAt = null
    return Promise.resolve()
  }

  insertLink(link: {
    did: string
    chainId: number
    address: string
    verifiedAt: Date
  }) {
    const existing = this.links.find(
      l =>
        l.chainId === link.chainId &&
        l.address === link.address &&
        !l.revokedAt,
    )
    if (existing) return Promise.resolve({wallet: existing, created: false})
    const wallet: UserWallet = {
      id: randomUUID(),
      createdAt: link.verifiedAt,
      revokedAt: null,
      ...link,
    }
    this.links.push(wallet)
    return Promise.resolve({wallet, created: true})
  }

  deleteExpiredChallenges(before: Date) {
    let n = 0
    for (const [id, c] of this.challenges) {
      if (c.expiresAt < before) {
        this.challenges.delete(id)
        n++
      }
    }
    return Promise.resolve(n)
  }
}
