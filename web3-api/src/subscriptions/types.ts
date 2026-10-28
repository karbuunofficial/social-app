export type PlanStatus = 'draft' | 'active' | 'archived'

export type EntitlementStatus = 'active' | 'expired' | 'revoked'

/**
 * A creator's time-limited access pass. `priceAmount` is integer base units of
 * `tokenAddress` on `chainId` (bigint, never a float). There is no automatic
 * renewal: a renewal is a new purchase.
 */
export type CreatorPlan = {
  id: string
  creatorDid: string
  name: string
  chainId: number
  tokenAddress: string
  priceAmount: bigint
  currency: string
  accessDurationSeconds: number
  status: PlanStatus
}

export type Entitlement = {
  id: string
  subscriberDid: string
  creatorDid: string
  planId: string
  /** The verified payment that granted this access. */
  paymentIntentId: string | null
  startsAt: Date
  expiresAt: Date
  status: EntitlementStatus
  revokedAt: Date | null
}
