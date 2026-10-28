import {Secp256k1Keypair} from '@atproto/crypto'
import {createServiceJwt} from '@atproto/xrpc-server'
import {describe, expect, it} from 'vitest'

import {AtprotoServiceAuthVerifier} from '../src/auth/atproto-service-auth.ts'
import {AppError} from '../src/errors.ts'

const SERVICE_DID = 'did:web:web3.example'
const USER_DID = 'did:plc:alice1234567890abcdefgh'
const LXM = 'app.web3.wallet.createChallenge'

/**
 * Unit tests use the real JWT minting and verification code with a locally
 * generated key and a stubbed DID-key lookup. They prove token checks, not DID
 * resolution against a live directory; see the integration test for that.
 */
async function setup() {
  const key = await Secp256k1Keypair.create()
  const verifier = new AtprotoServiceAuthVerifier(SERVICE_DID, did =>
    did === USER_DID
      ? Promise.resolve(key.did())
      : Promise.reject(new Error('unknown did')),
  )
  const token = (over: Partial<Parameters<typeof createServiceJwt>[0]> = {}) =>
    createServiceJwt({
      iss: USER_DID,
      aud: SERVICE_DID,
      lxm: LXM,
      keypair: key,
      ...over,
    })
  return {key, verifier, token}
}

const call = (verifier: AtprotoServiceAuthVerifier, jwt?: string, lxm = LXM) =>
  verifier.verify({
    headers: jwt ? {authorization: `Bearer ${jwt}`} : {},
    lxm,
  })

async function expect401(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    expect((e as AppError).statusCode).toBe(401)
    return
  }
  expect.unreachable('expected 401')
}

describe('AtprotoServiceAuthVerifier', () => {
  it('accepts a valid token and returns the DID', async () => {
    const {verifier, token} = await setup()
    expect(await call(verifier, await token())).toEqual({did: USER_DID})
  })

  it('rejects a missing or malformed Authorization header', async () => {
    const {verifier} = await setup()
    await expect401(call(verifier))
    await expect401(
      verifier.verify({headers: {authorization: 'Basic abc'}, lxm: LXM}),
    )
  })

  it('rejects a token addressed to another service', async () => {
    const {verifier, token} = await setup()
    await expect401(call(verifier, await token({aud: 'did:web:other.example'})))
  })

  it('rejects a token minted for a different method', async () => {
    const {verifier, token} = await setup()
    await expect401(
      call(verifier, await token({lxm: 'app.web3.wallet.verifyChallenge'})),
    )
  })

  it('rejects an expired token', async () => {
    const {verifier, token} = await setup()
    const past = Math.floor(Date.now() / 1000) - 600
    await expect401(call(verifier, await token({iat: past - 60, exp: past})))
  })

  it('rejects a token signed by a key that is not the DID signing key', async () => {
    const {verifier} = await setup()
    const impostor = await Secp256k1Keypair.create()
    const forged = await createServiceJwt({
      iss: USER_DID,
      aud: SERVICE_DID,
      lxm: LXM,
      keypair: impostor,
    })
    await expect401(call(verifier, forged))
  })

  it('rejects a DID that cannot be resolved without leaking why', async () => {
    const {verifier, key} = await setup()
    const jwt = await createServiceJwt({
      iss: 'did:plc:unknownunknownunknown00',
      aud: SERVICE_DID,
      lxm: LXM,
      keypair: key,
    })
    try {
      await call(verifier, jwt)
      expect.unreachable()
    } catch (e) {
      expect((e as AppError).message).toBe(
        'Invalid or expired authentication token',
      )
    }
  })
})
