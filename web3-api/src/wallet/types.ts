export type UserWallet = {
  id: string
  did: string
  chainId: number
  /** Lowercase 0x address, as stored. */
  address: string
  verifiedAt: Date
  createdAt: Date
  /** Set when the owner unlinked the wallet. Revoked rows are history only. */
  revokedAt: Date | null
}

export type WalletChallenge = {
  id: string
  did: string
  chainId: number
  /** Lowercase 0x address. */
  address: string
  /** SHA-256 of the nonce, hex. The raw nonce is never stored. */
  nonceHash: string
  /** The exact EIP-4361 text the user is asked to sign. */
  message: string
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

export type NewChallenge = Omit<WalletChallenge, 'id' | 'consumedAt'>

/**
 * Persistence boundary for wallet linking. Implementations must make
 * {@link consumeChallenge} atomic: of any number of concurrent calls for the
 * same challenge, at most one may return it.
 */
export interface WalletRepository {
  withTransaction<T>(fn: (repo: WalletRepository) => Promise<T>): Promise<T>
  /** The ACTIVE link for this wallet on this chain, if any. */
  findLinkByAddress(
    chainId: number,
    address: string,
  ): Promise<UserWallet | null>
  /** Most recent link for this wallet revoked at or after `since`. */
  findRecentlyReleased(
    chainId: number,
    address: string,
    since: Date,
  ): Promise<UserWallet | null>
  /** Active links only, oldest first. */
  listLinksForDid(did: string): Promise<UserWallet[]>
  getLinkById(id: string): Promise<UserWallet | null>
  /**
   * Revokes an active link that belongs to `did`. Returns null when there is
   * nothing to revoke (unknown, foreign or already revoked).
   */
  revokeLink(id: string, did: string, now: Date): Promise<UserWallet | null>
  /** True while an open payment intent references this wallet on this chain. */
  hasOpenPayments(chainId: number, address: string): Promise<boolean>
  countChallengesSince(did: string, since: Date): Promise<number>
  /** Marks every live challenge for this DID and address as consumed. */
  supersedeLiveChallenges(
    did: string,
    address: string,
    now: Date,
  ): Promise<void>
  insertChallenge(challenge: NewChallenge): Promise<WalletChallenge>
  /**
   * Atomically consumes a challenge that belongs to `did`, is unconsumed and
   * unexpired at `now`. Returns null in every other case.
   */
  consumeChallenge(
    id: string,
    did: string,
    now: Date,
  ): Promise<WalletChallenge | null>
  /**
   * Re-opens a challenge consumed by a request that failed for an
   * infrastructure reason before any verdict. Never used after a signature was
   * judged invalid.
   */
  reopenChallenge(id: string): Promise<void>
  /**
   * Inserts the link, or returns the existing active row for the same chain and
   * address with `created: false`.
   */
  insertLink(link: {
    did: string
    chainId: number
    address: string
    verifiedAt: Date
  }): Promise<{wallet: UserWallet; created: boolean}>
  /** Housekeeping: removes challenges that expired before `before`. */
  deleteExpiredChallenges(before: Date): Promise<number>
}
