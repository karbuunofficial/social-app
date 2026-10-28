import {describe, expect, it, jest} from '@jest/globals'

import {createWeb3Api, Web3ApiError} from '#/features/web3/api/client'

const SERVICE = 'did:web:web3.example'

type Call = {path: string; init: RequestInit}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: {'content-type': 'application/json'},
    ...init,
  })
}

function agentReturning(handler: (c: Call) => Response) {
  const calls: Call[] = []
  return {
    calls,
    agent: {
      fetchHandler: (path: string, init: RequestInit) => {
        const c = {path, init}
        calls.push(c)
        return Promise.resolve(handler(c))
      },
    },
  }
}

const headersOf = (c: Call) => c.init.headers as Record<string, string>

describe('proxy mode', () => {
  const opts = {
    mode: 'proxy',
    serviceDid: SERVICE,
    nsidPrefix: 'app.web3',
  } as const

  it('sends the request to the PDS with the atproto-proxy header', async () => {
    const {agent, calls} = agentReturning(() => json({wallets: []}))
    const api = createWeb3Api(agent, opts)
    await expect(api.listWallets()).resolves.toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/xrpc/app.web3.wallet.listWallets')
    expect(headersOf(calls[0])['atproto-proxy']).toBe(`${SERVICE}#web3_api`)
    // The client itself never sets an Authorization header.
    expect(headersOf(calls[0])['authorization']).toBeUndefined()
  })

  it('posts JSON bodies and builds query strings', async () => {
    const {agent, calls} = agentReturning(() => json({}))
    const api = createWeb3Api(agent, opts)
    await api.createChallenge({address: '0xabc', chainId: 84532})
    expect(calls[0].init.method).toBe('POST')
    expect(headersOf(calls[0])['content-type']).toBe('application/json')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      address: '0xabc',
      chainId: 84532,
    })
    await api.getTipRecipient('did:plc:bob', 84532)
    expect(calls[1].path).toBe(
      '/xrpc/app.web3.tip.getRecipient?did=did%3Aplc%3Abob&chainId=84532',
    )
  })

  it('puts the idempotency key in the body (a PDS proxy forwards few headers)', async () => {
    const {agent, calls} = agentReturning(() => json({tip: {}, transfer: {}}))
    await createWeb3Api(agent, opts).createTipIntent({
      recipientDid: 'did:plc:bob',
      chainId: 84532,
      amount: '1.5',
      senderAddress: '0xabc',
      idempotencyKey: 'key-12345678',
    })
    const body = JSON.parse(calls[0].init.body as string) as {
      idempotencyKey: string
    }
    expect(body.idempotencyKey).toBe('key-12345678')
  })

  it('uses the configured namespace', async () => {
    const {agent, calls} = agentReturning(() => json({wallets: []}))
    await createWeb3Api(agent, {
      ...opts,
      nsidPrefix: 'org.example.web3',
    }).listWallets()
    expect(calls[0].path).toBe('/xrpc/org.example.web3.wallet.listWallets')
  })
})

describe('direct mode', () => {
  const opts = {
    mode: 'direct',
    serviceDid: SERVICE,
    baseUrl: 'https://api.example.org',
    nsidPrefix: 'app.web3',
  } as const

  it('mints a fresh, method-bound service token for every call and keeps none', async () => {
    let n = 0
    const {agent, calls} = agentReturning(() => json({token: `token-${++n}`}))
    const fetchImpl = jest.fn(() =>
      Promise.resolve(json({wallets: []})),
    ) as unknown as typeof fetch
    const api = createWeb3Api(agent, opts, fetchImpl)

    await api.listWallets()
    await api.listWallets()

    // Two calls, two tokens requested from the PDS, each for the right audience and method.
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      const q = new URL(`http://x${c.path}`).searchParams
      expect(c.path).toContain('com.atproto.server.getServiceAuth')
      expect(q.get('aud')).toBe(SERVICE)
      expect(q.get('lxm')).toBe('app.web3.wallet.listWallets')
    }
    const sent = (
      fetchImpl as unknown as jest.Mock<(u: string, i: RequestInit) => unknown>
    ).mock.calls
    expect(
      (sent[0][1].headers as Record<string, string>)['authorization'],
    ).toBe('Bearer token-1')
    expect(
      (sent[1][1].headers as Record<string, string>)['authorization'],
    ).toBe('Bearer token-2')
    expect(sent[0][0]).toBe(
      'https://api.example.org/xrpc/app.web3.wallet.listWallets',
    )
  })

  it('refuses to run without a base URL', async () => {
    const {agent} = agentReturning(() => json({token: 't'}))
    const api = createWeb3Api(agent, {...opts, baseUrl: ''})
    await expect(api.listWallets()).rejects.toThrow(/baseUrl/)
  })
})

describe('errors', () => {
  const opts = {
    mode: 'proxy',
    serviceDid: SERVICE,
    nsidPrefix: 'app.web3',
  } as const

  it('parses the service error shape', async () => {
    const {agent} = agentReturning(() =>
      json(
        {error: {code: 'wallet_already_linked', message: 'taken'}},
        {status: 409},
      ),
    )
    const err = await createWeb3Api(agent, opts)
      .listWallets()
      .catch(e => e as Web3ApiError)
    expect(err).toBeInstanceOf(Web3ApiError)
    expect(err).toMatchObject({
      status: 409,
      code: 'wallet_already_linked',
      message: 'taken',
    })
  })

  it('parses the PDS error shape (for example a proxy failure)', async () => {
    const {agent} = agentReturning(() =>
      json(
        {
          error: 'InvalidRequest',
          message: 'could not resolve proxy did service url',
        },
        {status: 400},
      ),
    )
    const err = await createWeb3Api(agent, opts)
      .listWallets()
      .catch(e => e as Web3ApiError)
    expect(err).toMatchObject({status: 400, code: 'InvalidRequest'})
  })

  it('surfaces Retry-After on 429', async () => {
    const {agent} = agentReturning(() =>
      json(
        {error: {code: 'rate_limited', message: 'slow down'}},
        {status: 429, headers: {'retry-after': '17'}},
      ),
    )
    const err = await createWeb3Api(agent, opts)
      .listWallets()
      .catch(e => e as Web3ApiError)
    expect(err).toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 17,
    })
  })

  it('survives a non-JSON error body', async () => {
    const {agent} = agentReturning(
      () => new Response('<html>bad gateway</html>', {status: 502}),
    )
    const err = await createWeb3Api(agent, opts)
      .listWallets()
      .catch(e => e as Web3ApiError)
    expect(err).toMatchObject({status: 502, code: 'request_failed'})
  })
})
