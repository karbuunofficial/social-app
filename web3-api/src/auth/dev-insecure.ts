import {unauthorized} from '../errors.ts'
import {
  type AuthenticatedUser,
  type AuthRequest,
  type AuthVerifier,
} from './types.ts'

/**
 * Trusts an `x-dev-did` header. It proves nothing and exists only so route
 * logic can be exercised without a PDS. Configuration validation refuses
 * `AUTH_MODE=dev-insecure` when `NODE_ENV=production`.
 */
export class DevInsecureAuthVerifier implements AuthVerifier {
  verify(req: AuthRequest): Promise<AuthenticatedUser> {
    const header = req.headers['x-dev-did']
    const did = Array.isArray(header) ? header[0] : header
    if (!did || !/^did:(web|plc):[a-zA-Z0-9._:%-]+$/.test(did)) {
      return Promise.reject(unauthorized())
    }
    return Promise.resolve({did})
  }
}
