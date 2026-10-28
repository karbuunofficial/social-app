import {describe, expect, it} from 'vitest'

import {AtprotoServiceAuthVerifier} from '../src/auth/atproto-service-auth.ts'
import {AppError} from '../src/errors.ts'

/**
 * End-to-end check of the real flow: a real PDS mints a service-auth token with
 * `com.atproto.server.getServiceAuth`, and our verifier resolves the user's DID
 * document from a real PLC directory and validates the signature.
 *
 * Skipped unless a local AT Protocol network is configured, e.g. the repo's
 * `dev-env`:
 *   ATPROTO_PDS_URL=http://localhost:3000 ATPROTO_PLC_URL=http://localhost:3001
 *   ATPROTO_TEST_IDENTIFIER=<handle> ATPROTO_TEST_PASSWORD=<password>
 */
const pds = process.env.ATPROTO_PDS_URL
const plc = process.env.ATPROTO_PLC_URL
const identifier = process.env.ATPROTO_TEST_IDENTIFIER
const password = process.env.ATPROTO_TEST_PASSWORD
const configured = Boolean(pds && plc && identifier && password)

const SERVICE_DID = 'did:web:web3.example'
const LXM = 'app.web3.wallet.createChallenge'

async function json(res: Response) {
  expect(res.ok, `${res.url} -> ${res.status}`).toBe(true)
  return (await res.json()) as Record<string, string>
}

describe.skipIf(!configured)('real PDS service-auth flow', () => {
  async function session() {
    return json(
      await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({identifier, password}),
      }),
    )
  }

  async function serviceToken(accessJwt: string, aud: string, lxm: string) {
    const q = new URLSearchParams({aud, lxm})
    const res = await fetch(
      `${pds}/xrpc/com.atproto.server.getServiceAuth?${q}`,
      {headers: {authorization: `Bearer ${accessJwt}`}},
    )
    return (await json(res)).token as string
  }

  const verifier = () =>
    AtprotoServiceAuthVerifier.fromPlcUrl(SERVICE_DID, plc!, {
      allowInsecurePlc: true,
    })

  const call = (v: AtprotoServiceAuthVerifier, token: string, lxm = LXM) =>
    v.verify({headers: {authorization: `Bearer ${token}`}, lxm})

  it('verifies a token minted by a real PDS and returns the real DID', async () => {
    const {accessJwt, did} = await session()
    const token = await serviceToken(accessJwt!, SERVICE_DID, LXM)
    expect(await call(verifier(), token)).toEqual({did})
  })

  it('rejects the real token when addressed to another service', async () => {
    const {accessJwt} = await session()
    const token = await serviceToken(accessJwt!, 'did:web:other.example', LXM)
    await expect(call(verifier(), token)).rejects.toBeInstanceOf(AppError)
  })

  it('rejects the real token when replayed against a different method', async () => {
    const {accessJwt} = await session()
    const token = await serviceToken(accessJwt!, SERVICE_DID, LXM)
    await expect(
      call(verifier(), token, 'app.web3.wallet.verifyChallenge'),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('rejects a real token with a tampered payload', async () => {
    const {accessJwt} = await session()
    const token = await serviceToken(accessJwt!, SERVICE_DID, LXM)
    const [h, p, s] = token.split('.')
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString()) as {
      iss: string
    }
    payload.iss = 'did:plc:someoneelse0000000000000'
    const forged = [
      h,
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      s,
    ].join('.')
    await expect(call(verifier(), forged)).rejects.toBeInstanceOf(AppError)
  })

  it('rejects a PDS access token (wrong kind of JWT)', async () => {
    const {accessJwt} = await session()
    await expect(call(verifier(), accessJwt!)).rejects.toBeInstanceOf(AppError)
  })
})
