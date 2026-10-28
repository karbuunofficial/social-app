/**
 * XRPC method names. Requests are served at `/xrpc/<nsid>` so that a user's PDS
 * can proxy to this service with the `atproto-proxy` header, the same
 * mechanism the app already uses for the AppView and chat.
 *
 * The namespace is configuration (`NSID_PREFIX`), not code. `app.web3` is a
 * placeholder: a real prefix must be a reverse-DNS name under a domain the
 * project controls, and production refuses to start with the placeholder.
 * Never use `app.bsky`, `chat.bsky` or `com.atproto`.
 */
export const PLACEHOLDER_NSID_PREFIX = 'app.web3'

const RESERVED_PREFIXES = [
  'app.bsky',
  'chat.bsky',
  'com.atproto',
  'tools.ozone',
]

const PREFIX_PATTERN =
  /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]([a-z0-9-]{0,61}[a-z0-9])?){1,}$/

export function isValidNsidPrefix(prefix: string): boolean {
  return (
    prefix.length <= 120 &&
    PREFIX_PATTERN.test(prefix) &&
    !RESERVED_PREFIXES.some(r => prefix === r || prefix.startsWith(`${r}.`))
  )
}

export function buildNsids(prefix: string) {
  return {
    walletCreateChallenge: `${prefix}.wallet.createChallenge`,
    walletVerifyChallenge: `${prefix}.wallet.verifyChallenge`,
    walletList: `${prefix}.wallet.listWallets`,
    walletUnlink: `${prefix}.wallet.unlinkWallet`,
    tipGetRecipient: `${prefix}.tip.getRecipient`,
    tipCreateIntent: `${prefix}.tip.createIntent`,
    tipSubmitTransaction: `${prefix}.tip.submitTransaction`,
    tipGetIntent: `${prefix}.tip.getIntent`,
    tipListIntents: `${prefix}.tip.listIntents`,
    configGet: `${prefix}.config.get`,
  } as const
}

export type Nsids = ReturnType<typeof buildNsids>

/** Default (placeholder) names; used by tests and local development. */
export const NSID: Nsids = buildNsids(PLACEHOLDER_NSID_PREFIX)
