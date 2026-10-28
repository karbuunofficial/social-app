import {describe, expect, it} from 'vitest'

import {DevInsecureAuthVerifier} from '../src/auth/dev-insecure.ts'
import {NSID} from '../src/lexicon-ids.ts'
import {defaultRouteLimits, SlidingWindowLimiter} from '../src/rate-limit.ts'
import {buildServer} from '../src/server.ts'
import {makeService, testConfig} from './helpers/fixtures.ts'
import {tippingDisabled} from './helpers/stubs.ts'

async function app(trustProxy: number) {
  const {service, repo} = makeService()
  return buildServer({
    config: {...testConfig(), TRUST_PROXY: trustProxy},
    db: {query: () => Promise.resolve({rows: []} as never)},
    auth: new DevInsecureAuthVerifier(),
    wallets: service,
    tips: tippingDisabled(repo),
    nsids: NSID,
    // One request per address per minute, so the second call shows the key.
    limits: {
      ...defaultRouteLimits(10_000),
      global: new SlidingWindowLimiter(1, 60_000),
    },
  })
}

const get = (a: Awaited<ReturnType<typeof app>>, xff: string) =>
  a.inject({
    url: '/health',
    remoteAddress: '10.0.0.1',
    headers: {'x-forwarded-for': xff},
  })

describe('TRUST_PROXY', () => {
  it('ignores X-Forwarded-For when no proxy hop is configured', async () => {
    const a = await app(0)
    expect((await get(a, '1.1.1.1')).statusCode).toBe(200)
    // A client cannot dodge the per-address limit by inventing a new address.
    expect((await get(a, '2.2.2.2')).statusCode).toBe(429)
    await a.close()
  })

  it('trusts exactly the configured number of hops', async () => {
    const a = await app(1)
    expect((await get(a, '1.1.1.1')).statusCode).toBe(200)
    expect((await get(a, '2.2.2.2')).statusCode).toBe(200)
    // The last entry is the one our proxy appended; earlier ones are client-supplied.
    expect((await get(a, '9.9.9.9, 2.2.2.2')).statusCode).toBe(429)
    await a.close()
  })
})
