/**
 * The identity a request has proven. `did` is an AT Protocol DID that the
 * caller demonstrably controls (when using the atproto verifier).
 */
export type AuthenticatedUser = {did: string}

export type AuthRequest = {
  headers: Record<string, string | string[] | undefined>
  /**
   * The XRPC method the request is calling. Service-auth tokens may be bound
   * to one method (`lxm`), which prevents a token minted for one endpoint
   * being replayed against another.
   */
  lxm: string
}

/**
 * Authentication boundary. Route handlers depend on this interface only, so
 * the verification strategy can change without touching business logic.
 */
export interface AuthVerifier {
  verify(req: AuthRequest): Promise<AuthenticatedUser>
}
