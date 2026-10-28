import {IdResolver} from '@atproto/identity'
import {verifyJwt} from '@atproto/xrpc-server'

import {unauthorized} from '../errors.ts'
import {
  type AuthenticatedUser,
  type AuthRequest,
  type AuthVerifier,
} from './types.ts'

type SigningKeyResolver = (
  did: string,
  forceRefresh: boolean,
) => Promise<string>

/**
 * Verifies AT Protocol service-auth JWTs: tokens a user's PDS mints with
 * `com.atproto.server.getServiceAuth` (or attaches when proxying a request via
 * the `atproto-proxy` header). The token proves the caller controls the DID in
 * `iss`; it is checked for signature (against the DID document's signing key),
 * expiry, audience (this service's DID), and method (`lxm`).
 *
 * The end-to-end flow against a real PDS is covered by
 * `test/atproto-service-auth.integration.test.ts`, which is skipped unless a
 * local AT Protocol network is available.
 */
export class AtprotoServiceAuthVerifier implements AuthVerifier {
  private readonly serviceDid: string
  private readonly getSigningKey: SigningKeyResolver

  constructor(serviceDid: string, getSigningKey: SigningKeyResolver) {
    this.serviceDid = serviceDid
    this.getSigningKey = getSigningKey
  }

  /**
   * By default DID documents are fetched with `@atproto/identity`'s
   * SSRF-protected fetch, which refuses plain `http:`. That is what production
   * needs (`https://plc.directory`). `allowInsecurePlc` exists only so a local
   * AT Protocol network (plain-http PLC) can be used in development and tests:
   * it permits http to the single configured PLC origin and nothing else.
   */
  static fromPlcUrl(
    serviceDid: string,
    plcUrl: string,
    opts: {allowInsecurePlc?: boolean} = {},
  ) {
    const plc = new URL(plcUrl)
    const fetch =
      opts.allowInsecurePlc && plc.protocol === 'http:'
        ? (input: RequestInfo | URL, init?: RequestInit) => {
            const req = new Request(input, init)
            if (new URL(req.url).origin !== plc.origin) {
              return Promise.reject(
                new Error('insecure fetch is limited to the configured PLC'),
              )
            }
            return globalThis.fetch(req)
          }
        : undefined
    const idResolver = new IdResolver({plcUrl, fetch})
    return new AtprotoServiceAuthVerifier(serviceDid, (did, forceRefresh) =>
      idResolver.did.resolveAtprotoKey(did, forceRefresh),
    )
  }

  async verify(req: AuthRequest): Promise<AuthenticatedUser> {
    const header = req.headers['authorization']
    const value = Array.isArray(header) ? header[0] : header
    const match = value?.match(/^Bearer\s+(\S+)$/i)
    if (!match?.[1]) throw unauthorized()

    try {
      const payload = await verifyJwt(match[1], this.serviceDid, req.lxm, iss =>
        this.getSigningKey(iss.split('#')[0] ?? iss, false),
      )
      const did = payload.iss.split('#')[0]
      if (!did || !did.startsWith('did:')) throw unauthorized()
      return {did}
    } catch {
      // Do not leak why verification failed (expired, wrong audience, bad
      // signature, unresolvable DID): all look the same to the caller.
      throw unauthorized('Invalid or expired authentication token')
    }
  }
}
