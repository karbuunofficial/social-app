import {type FastifyInstance} from 'fastify'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {DevInsecureAuthVerifier} from '../src/auth/dev-insecure.ts'
import {NSID} from '../src/lexicon-ids.ts'
import {defaultRouteLimits} from '../src/rate-limit.ts'
import {buildServer} from '../src/server.ts'
import {ALICE, makeService, newWallet, testConfig} from './helpers/fixtures.ts'
import {tippingDisabled} from './helpers/stubs.ts'

type ErrorBody = {error: {code: string}}

let app: FastifyInstance
let dbUp = true

beforeEach(async () => {
  dbUp = true
  const {service, repo} = makeService()
  app = await buildServer({
    config: {...testConfig(), CORS_ALLOWED_ORIGINS: ['http://localhost:19006']},
    db: {
      query: () =>
        dbUp
          ? Promise.resolve({rows: []} as never)
          : Promise.reject(new Error('down')),
    },
    auth: new DevInsecureAuthVerifier(),
    wallets: service,
    tips: tippingDisabled(repo),
    nsids: NSID,
    limits: defaultRouteLimits(10_000),
  })
})

afterEach(() => app.close())

const post = (nsid: string, payload: unknown, did: string | null = ALICE) =>
  app.inject({
    method: 'POST',
    url: `/xrpc/${nsid}`,
    payload: payload as object,
    headers: did ? {'x-dev-did': did} : {},
  })

describe('health', () => {
  it('reports liveness without touching dependencies', async () => {
    dbUp = false
    const res = await app.inject({url: '/health'})
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({status: 'ok'})
  })

  it('reports readiness from the database', async () => {
    expect((await app.inject({url: '/health/ready'})).statusCode).toBe(200)
    dbUp = false
    const res = await app.inject({url: '/health/ready'})
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({status: 'unavailable'})
  })
})

describe('authentication', () => {
  it.each([
    [NSID.walletCreateChallenge, 'POST'],
    [NSID.walletVerifyChallenge, 'POST'],
    [NSID.walletList, 'GET'],
  ])('requires authentication for %s', async (nsid, method) => {
    const res = await app.inject({
      method: method as 'GET' | 'POST',
      url: `/xrpc/${nsid}`,
      payload: method === 'POST' ? {} : undefined,
    })
    expect(res.statusCode).toBe(401)
    expect(res.json<ErrorBody>().error.code).toBe('unauthorized')
  })

  it('rejects a malformed DID header', async () => {
    const res = await app.inject({
      url: `/xrpc/${NSID.walletList}`,
      headers: {'x-dev-did': 'not-a-did'},
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('validation', () => {
  it('rejects bad bodies without echoing submitted values', async () => {
    const res = await post(NSID.walletCreateChallenge, {
      address: 'secret-value-123',
      chainId: 'oops',
      extra: 'surprise',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.code).toBe('validation_error')
    expect(res.body).not.toContain('secret-value-123')
    expect(res.body).not.toContain('surprise')
  })

  it('rejects malformed JSON as a client error, not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/xrpc/${NSID.walletCreateChallenge}`,
      headers: {'x-dev-did': ALICE, 'content-type': 'application/json'},
      payload: '{not json',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.code).toBe('bad_request')
  })

  it('rejects oversized bodies', async () => {
    const res = await post(NSID.walletCreateChallenge, {
      pad: 'x'.repeat(40_000),
    })
    expect(res.statusCode).toBe(413)
  })

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await app.inject({url: '/nope'})
    expect(res.statusCode).toBe(404)
    expect(res.json<ErrorBody>().error.code).toBe('not_found')
  })
})

describe('wallet linking over HTTP', () => {
  it('links a wallet end to end', async () => {
    const wallet = newWallet()
    const created = await post(NSID.walletCreateChallenge, {
      address: wallet.address,
      chainId: 84532,
    })
    expect(created.statusCode).toBe(200)
    const {challengeId, message} = created.json<{
      challengeId: string
      message: string
    }>()

    const signature = await wallet.signMessage({message})
    const verified = await post(NSID.walletVerifyChallenge, {
      challengeId,
      signature,
    })
    expect(verified.statusCode).toBe(201)
    expect(verified.json<{wallet: unknown}>().wallet).toMatchObject({
      address: wallet.address,
      chainId: 84532,
    })

    const replay = await post(NSID.walletVerifyChallenge, {
      challengeId,
      signature,
    })
    expect(replay.statusCode).toBe(400)
    expect(replay.json<ErrorBody>().error.code).toBe(
      'invalid_or_expired_challenge',
    )

    const list = await app.inject({
      url: `/xrpc/${NSID.walletList}`,
      headers: {'x-dev-did': ALICE},
    })
    expect(list.json<{wallets: unknown[]}>().wallets).toHaveLength(1)
  })
})

describe('CORS', () => {
  it('allows only configured origins', async () => {
    const ok = await app.inject({
      url: '/health',
      headers: {origin: 'http://localhost:19006'},
    })
    expect(ok.headers['access-control-allow-origin']).toBe(
      'http://localhost:19006',
    )
    const bad = await app.inject({
      url: '/health',
      headers: {origin: 'https://evil.example'},
    })
    expect(bad.headers['access-control-allow-origin']).toBeUndefined()
  })
})
