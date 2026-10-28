import {type AccessDecision} from './rules.ts'
import {type CreatorPlan, type Entitlement} from './types.ts'

/**
 * Time-limited creator access passes. Interface only in Phase 1: nothing here
 * is implemented, routed, or connected to payments or content storage.
 *
 * Concepts: creator plan -> purchase intent (a payment intent for the plan
 * price) -> verified payment (see TippingService reconciliation) -> access
 * entitlement with an expiry -> access authorization on every read.
 */
export interface SubscriptionService {
  createPlan(
    creatorDid: string,
    input: {
      name: string
      chainId: number
      /** Decimal string in token units, e.g. "5". Parsed with bigint maths. */
      price: string
      accessDurationSeconds: number
    },
  ): Promise<CreatorPlan>

  listPlans(creatorDid: string): Promise<CreatorPlan[]>

  /**
   * Starts a purchase: creates the payment intent for the plan price against
   * the creator's verified wallet. Returns the intent id; no access is granted.
   */
  createPurchaseIntent(
    subscriberDid: string,
    planId: string,
  ): Promise<{paymentIntentId: string}>

  /**
   * Grants access ONLY for a payment intent already verified on-chain with the
   * required confirmations. Idempotent per payment intent.
   */
  grantEntitlement(paymentIntentId: string): Promise<Entitlement>

  /**
   * Revokes an entitlement, for example after a reorg removed its payment, or
   * for moderation. Takes effect on the next authorization check.
   */
  revokeEntitlement(entitlementId: string, reason: string): Promise<void>

  /** Marks entitlements past their expiry as expired. Safe to run repeatedly. */
  expireEntitlements(now: Date): Promise<number>

  /** The only gate for subscriber-only reads. See `authorizeAccess`. */
  authorizeAccess(
    requesterDid: string,
    creatorDid: string,
  ): Promise<AccessDecision>
}
