export type UserWallet = {
  id: string
  did: string
  chainId: number
  /** Lowercase 0x address, as stored. */
  address: string
  verifiedAt: Date
  createdAt: Date
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
  findLinkByAddress(
    chainId: number,
    address: string,
  ): Promise<UserWallet | null>
  listLinksForDid(did: string): Promise<UserWallet[]>
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
   * Inserts the link, or returns the existing row for the same chain and
   * address with `created: false`.
   */
  insertLink(link: {
    did: string
    chainId: number
    address: string
    verifiedAt: Date
  }): Promise<{wallet: UserWallet; created: boolean}>
}
