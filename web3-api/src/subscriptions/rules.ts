import {type Entitlement} from './types.ts'

/**
 * The access window for a new purchase. A renewal bought while an entitlement
 * is still running starts when the current one ends, so no paid time is lost
 * and passes do not overlap.
 */
export function grantWindow(params: {
  now: Date
  accessDurationSeconds: number
  currentExpiresAt?: Date | null
}): {startsAt: Date; expiresAt: Date} {
  if (
    !Number.isInteger(params.accessDurationSeconds) ||
    params.accessDurationSeconds <= 0
  ) {
    throw new RangeError('accessDurationSeconds must be a positive integer')
  }
  const startsAt =
    params.currentExpiresAt && params.currentExpiresAt > params.now
      ? params.currentExpiresAt
      : params.now
  return {
    startsAt,
    expiresAt: new Date(
      startsAt.getTime() + params.accessDurationSeconds * 1000,
    ),
  }
}

export type AccessDecision =
  | {allowed: true; reason: 'owner'}
  | {allowed: true; reason: 'entitled'; entitlementId: string; expiresAt: Date}
  | {
      allowed: false
      reason: 'no_entitlement' | 'not_started' | 'expired' | 'revoked'
    }

/**
 * Decides whether `requesterDid` may read `creatorDid`'s subscriber-only
 * content right now. Pure and deterministic: the clock is a parameter. This is
 * the single decision point every private-content endpoint must call
 * server-side. It never trusts a client-supplied "I am subscribed" claim.
 */
export function authorizeAccess(params: {
  requesterDid: string
  creatorDid: string
  entitlements: readonly Entitlement[]
  now: Date
}): AccessDecision {
  const {requesterDid, creatorDid, now} = params
  if (requesterDid === creatorDid) return {allowed: true, reason: 'owner'}

  const mine = params.entitlements.filter(
    e => e.subscriberDid === requesterDid && e.creatorDid === creatorDid,
  )
  if (mine.length === 0) return {allowed: false, reason: 'no_entitlement'}

  const live = mine.find(
    e => e.status === 'active' && e.startsAt <= now && now < e.expiresAt,
  )
  if (live) {
    return {
      allowed: true,
      reason: 'entitled',
      entitlementId: live.id,
      expiresAt: live.expiresAt,
    }
  }
  if (mine.some(e => e.status === 'active' && e.startsAt > now)) {
    return {allowed: false, reason: 'not_started'}
  }
  // Prefer reporting revocation over plain expiry when both apply.
  if (mine.some(e => e.status === 'revoked')) {
    return {allowed: false, reason: 'revoked'}
  }
  return {allowed: false, reason: 'expired'}
}
