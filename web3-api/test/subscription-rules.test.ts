import {describe, expect, it} from 'vitest'

import {authorizeAccess, grantWindow} from '../src/subscriptions/rules.ts'
import {type Entitlement} from '../src/subscriptions/types.ts'

const NOW = new Date('2026-11-01T12:00:00Z')
const at = (offsetSeconds: number) =>
  new Date(NOW.getTime() + offsetSeconds * 1000)

const ent = (over: Partial<Entitlement> = {}): Entitlement => ({
  id: 'e1',
  subscriberDid: 'did:plc:sub',
  creatorDid: 'did:plc:creator',
  planId: 'p1',
  paymentIntentId: 'pi1',
  startsAt: at(-3600),
  expiresAt: at(3600),
  status: 'active',
  revokedAt: null,
  ...over,
})

const decide = (entitlements: Entitlement[], requester = 'did:plc:sub') =>
  authorizeAccess({
    requesterDid: requester,
    creatorDid: 'did:plc:creator',
    entitlements,
    now: NOW,
  })

describe('grantWindow', () => {
  it('starts now for a first purchase', () => {
    const w = grantWindow({now: NOW, accessDurationSeconds: 86400})
    expect(w.startsAt).toEqual(NOW)
    expect(w.expiresAt).toEqual(at(86400))
  })

  it('queues a renewal after the running pass so no time is lost', () => {
    const w = grantWindow({
      now: NOW,
      accessDurationSeconds: 86400,
      currentExpiresAt: at(3600),
    })
    expect(w.startsAt).toEqual(at(3600))
    expect(w.expiresAt).toEqual(at(3600 + 86400))
  })

  it('ignores an already expired pass', () => {
    const w = grantWindow({
      now: NOW,
      accessDurationSeconds: 60,
      currentExpiresAt: at(-10),
    })
    expect(w.startsAt).toEqual(NOW)
  })

  it('rejects non-positive or fractional durations', () => {
    for (const d of [0, -1, 1.5, Number.NaN]) {
      expect(() => grantWindow({now: NOW, accessDurationSeconds: d})).toThrow()
    }
  })
})

describe('authorizeAccess', () => {
  it('always allows the creator', () => {
    expect(decide([], 'did:plc:creator')).toEqual({
      allowed: true,
      reason: 'owner',
    })
  })

  it('denies without an entitlement', () => {
    expect(decide([])).toEqual({allowed: false, reason: 'no_entitlement'})
    // Someone else's entitlement is not mine.
    expect(decide([ent({subscriberDid: 'did:plc:other'})])).toEqual({
      allowed: false,
      reason: 'no_entitlement',
    })
    // A pass for a different creator is not valid here.
    expect(decide([ent({creatorDid: 'did:plc:someone-else'})])).toEqual({
      allowed: false,
      reason: 'no_entitlement',
    })
  })

  it('allows during the window and denies at the exact expiry instant', () => {
    expect(decide([ent()])).toMatchObject({allowed: true, reason: 'entitled'})
    expect(decide([ent({expiresAt: NOW})])).toEqual({
      allowed: false,
      reason: 'expired',
    })
  })

  it('denies revoked passes even inside the window', () => {
    expect(decide([ent({status: 'revoked', revokedAt: at(-60)})])).toEqual({
      allowed: false,
      reason: 'revoked',
    })
  })

  it('denies a pass that has not started yet', () => {
    expect(decide([ent({startsAt: at(60), expiresAt: at(7200)})])).toEqual({
      allowed: false,
      reason: 'not_started',
    })
  })

  it('denies passes already marked expired', () => {
    expect(decide([ent({status: 'expired'})])).toEqual({
      allowed: false,
      reason: 'expired',
    })
  })

  it('allows when any one pass is live', () => {
    const d = decide([
      ent({id: 'old', status: 'expired', expiresAt: at(-10)}),
      ent({id: 'live'}),
    ])
    expect(d).toMatchObject({allowed: true, entitlementId: 'live'})
  })
})
