/**
 * XRPC method names. Requests are served at `/xrpc/<nsid>` so that a user's PDS
 * can proxy to this service with the `atproto-proxy` header, the same
 * mechanism the app already uses for the AppView and chat.
 *
 * TODO(brand): `app.web3` is a placeholder. NSIDs must be a reverse-DNS name
 * under a domain the project controls; replace it (and register lexicons)
 * before any public deployment. Never use `app.bsky.*`.
 */
export const NSID = {
  walletCreateChallenge: 'app.web3.wallet.createChallenge',
  walletVerifyChallenge: 'app.web3.wallet.verifyChallenge',
  walletList: 'app.web3.wallet.listWallets',
} as const
