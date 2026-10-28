# Incremental plan: wallets, tipping, subscriptions, monetization

Status: proposal for review. No feature code exists yet. Read
`docs/architecture.md` and `docs/baseline.md` first. Items marked **verify**
depend on third-party SDK or platform behavior that changes quickly and must be
confirmed in a spike, not assumed from this document.

## Principles

1. **Do not replace the AT Protocol stack.** Identity (DID, handle), posts,
   follows and feeds stay on a PDS and AppView. Web3 and money features are an
   additional layer keyed by DID.
2. **Add, do not rewrite.** New code lives in `src/features/web3/` (the
   `AGENTS.md` "feature" pattern) behind a flag, with the smallest possible
   hooks into existing screens.
3. **The client is never trusted with money state.** The app proposes; a
   backend service verifies signatures and on-chain receipts and records them.
4. **One reviewable PR per step**, each with tests, each shippable with the
   flag off.

## Constraints that shape the design

- **AT Protocol repos are public.** Anything written to a user's repo can be
  read by anyone, and relays and AppViews mirror it. Subscriber-only content
  cannot be stored as ordinary records. It needs a separate store (below).
- **The AppView owns notifications, counts and feeds.** A tip cannot appear in
  `app.bsky.notification.listNotifications` unless we run our own AppView.
  Tips and subscriptions therefore need their own notification surface.
- **Bluesky services are hard-coded** (inventory in `architecture.md`). A
  branded network needs a decision on how far to diverge (Decision 1).
- **Public env vars.** `EXPO_PUBLIC_*` ends up in the bundle. The thirdweb
  _client ID_ is designed to be public; the thirdweb _secret key_ is not and
  must only exist in the backend.
- **Asset licensing.** `ASSETS.md` says the Bluesky marks, commissioned
  illustrations, the main icon set and some artwork are not MIT-licensed and
  must be replaced in a fork. Treat this as a launch blocker for branding.

## Decisions needed from you

| #   | Decision | Recommendation |
| --- | -------- | -------------- |
| 1   | How "standalone"? (a) stay on the public Bluesky network and add our own services; (b) also run our own PDS (own signup and handle domain, still federated); (c) also run our own AppView, relay and chat (full independence) | Start with (a), move to (b) when signup branding needs it. (c) is a large, separate program; revisit only with a concrete need (custom notifications and feeds for tips). |
| 2   | Custody | Non-custodial first: tips go wallet to wallet, the platform never holds funds. Custody triggers money-transmission and licensing questions. |
| 3   | Subscription model | Time-limited access pass (NFT or entitlement) bought per period, before any auto-renewing pull payments. |
| 4   | Jurisdictions and legal entity | Needs counsel before Phase 3 ships to real users (KYC/AML, tax reporting, sanctions screening, consumer rules). App-store policy for crypto and digital goods also applies (**verify** current Apple and Google rules). |
| 5   | Token | No platform token in scope. Use USDC on Base. |

## Target architecture

```
 App (this repo)                          Brand service (new, separate deploy)
 src/features/web3/                       TypeScript + PostgreSQL
   thirdweb wallet provider                 - verifies atproto service-auth JWT (who is this DID)
   link-wallet, tip, subscribe UI           - verifies wallet signature (who owns this address)
        |                                    - wallet_links, tips, subscriptions, entitlements
        | atproto-proxy: did:web:<brand>#brand_service   - chain indexer (Base)
        | (same mechanism as appview/chat)   - webhooks, payouts, admin
        v
   User's PDS ---> brand service        Base (chain 8453; Base Sepolia 84532 for test)
                                         USDC transfers, optional TipRouter / pass contracts
```

Why the brand service is reached through the proxy header: `clients.ts` already
builds appview and chat clients that way, and the app already obtains
service-auth tokens for video. A fourth client (`buildBrandClient`) follows
existing code and gives DID-authenticated calls with no new login. **Verify**
that the target PDS will proxy to a custom service DID (self-hosted PDS: yes by
configuration; bsky.social: confirm). Fallback: call the service directly with
a token from `com.atproto.server.getServiceAuth`, as video upload does.

Backend lives outside this client repo (new repository, or a `services/` dir if
you prefer a monorepo). Postgres is the system of record for business data.
Never store money state in the AT repo.

## Phases

### Phase 0: Baseline and fork hygiene (this PR)

Done: install, lint, typecheck, prettier, 840 unit tests, production web build,
Go server, local backend, authenticated smoke test (`baseline.md`).

### Phase 1: Foundations, no user-visible change

1. **Flag and scaffolding.** `EXPO_PUBLIC_WEB3_ENABLED` (default off),
   `src/features/web3/` with a README, a `useWeb3Enabled()` hook, and tests.
   Accept: app is byte-for-byte behaviorally unchanged with the flag off.
2. **thirdweb spike (time-boxed, separate branch).** Add the thirdweb SDK and
   prove, on web and on one native platform, that (a) the bundle builds under
   the current webpack and Metro configs, (b) an in-app wallet or social login
   connects, (c) a message can be signed, (d) a Base Sepolia transaction can be
   sent. **Verify** React Native 0.86 and Expo 57 support, required polyfills
   and native modules, and the bundle-size cost (the web build already exceeds
   webpack's 586 KiB budget). Output: a go/no-go note and the exact install
   recipe. If native is not viable, ship web-first.
3. **Config and secrets.** Add `EXPO_PUBLIC_THIRDWEB_CLIENT_ID`,
   `EXPO_PUBLIC_BASE_CHAIN` (mainnet or sepolia) to `.env.example`. Document
   that the secret key is backend-only. Add secret scanning to CI.
4. **Brand service skeleton** (new repo): health endpoint, Postgres migrations
   framework, service-auth JWT verification with tests against the `dev-env`
   PDS, local docker-compose or equivalent.

### Phase 2: Wallet linking (identity bridge)

1. Backend: `wallet_links(did, address, chain_id, created_at, revoked_at)`,
   unique on `(did, address)`. `POST /link` requires **both** a valid
   service-auth token (proves the DID) and a signed challenge (proves the
   wallet). Challenge is a SIWE-style message containing DID, nonce, domain,
   chain and expiry; nonces are single-use. `DELETE /link` to revoke.
2. App: `buildBrandClient`, wallet provider placed below Session and Query in
   the provider tree, Settings screen "Wallet" (new route per `routes.ts`
   conventions), connect, link, unlink, show linked address.
3. Optional: show a linked-wallet badge on a profile, driven by the service,
   not by a repo record. A public repo record can come later if wanted.
   Accept: a user can link and unlink; replaying a signature fails; a token for
   DID A cannot link to DID B.

### Phase 3: Creator tipping

1. Contracts: start with **no custom contract**. Tip = USDC `transfer` from
   the tipper to the creator's linked address on Base. Take the USDC address
   from Circle's official documentation for each network; do not copy it from
   memory or a chat message. Add a thin `TipRouter` (emits post URI and fee
   split) only if a platform fee is required, with an external audit before
   mainnet.
2. Backend: `tips(tx_hash PK, chain_id, from_address, to_address, did_from,
   did_to, post_uri, amount, token, status, block_number)`. An indexer or
   webhook confirms receipts and finality; inserts are idempotent on
   `tx_hash`. The client may post a "pending" intent, but only the indexer can
   set `confirmed`.
3. App: "Tip" action on the post action row and profile (a Dialog; remember
   the `control.close(() => ...)` rule in `AGENTS.md`), amount picker,
   transaction progress and error states, creator view of received tips.
   All strings through Lingui; `testID`s on new controls.
4. Notifications: a separate "Tips" list from the service, plus push via
   `expo-notifications` from the backend. Do not try to inject into the
   AppView notification feed.
   Accept: end-to-end on Base Sepolia from two `dev-env` accounts; double
   delivery of the same webhook creates one row; unlinked creators cannot be
   tipped (UI explains why).

### Phase 4: Subscriptions and gated content

1. Entitlement model first (`subscriptions`, `entitlements(did, creator_did,
   tier, expires_at)`), independent of how payment arrives.
2. Payment: a purchasable, time-limited pass (ERC-1155 or similar, one token id
   per creator tier, expiry recorded on-chain or in Postgres). Renewal is a
   new purchase with a reminder. Auto-renewing pulls (ERC-20 allowance or
   smart-account session keys) are a later option; **verify** thirdweb's
   current smart-account support before committing.
3. Gated content: the public record is a teaser post (normal
   `app.bsky.feed.post`, with a link or embed card). The gated body or media
   lives in the brand service or object storage, encrypted at rest, and is
   served only after an entitlement check. Document clearly in the UI that
   gated content is outside the public AT Protocol repo. **Verify** whether
   AT Protocol permissioned-data work has matured before building bespoke
   storage.
4. App: creator tier setup, subscribe flow, gated-post rendering, entitlement
   expiry handling, cache invalidation via TanStack Query keys built with
   `createQueryKey`.
   Accept: an expired pass loses access immediately; refunds and chargeback
   policy decided and written down.

### Phase 5: Monetization operations

Platform fee configuration and reporting, creator payouts or direct-settlement
reporting, tax and KYC integration per Decision 4, fraud and abuse limits
(rate limits, minimum amounts, sanctioned-address screening), admin tooling,
analytics (privacy-reviewed), moderation hooks (tips and gating must respect
labelers and takedowns), and support runbooks.

### Parallel track: Branding and independence

Not blocked by the phases above, can be done by a different person.

1. Replace all `ASSETS.md` items (marks, illustrations, icons, artwork).
2. `app.config.js`: name, slug, scheme, bundle ids, associated domains, EAS
   owner and project id. `web/index.html`, `bskyweb/templates/*`.
3. Replace help, status, download, blog and legal links in
   `src/lib/constants.ts` and the Terms, Privacy and Guidelines screens.
4. Stand up your own metrics, Sentry and GrowthBook (envs already exist), and
   your own `*_DEV_URL` workers or remove the dependency on them.
5. Optional per Decision 1: own PDS, then own video, GIF and link-card
   services. Do **not** rename `app.bsky.*` identifiers.
6. Add a CSP to the production edge. `bskyweb` currently sets
   `X-Content-Type-Options` and `X-Frame-Options` but no
   `Content-Security-Policy`; wallet SDKs load iframes and RPC endpoints, so
   the allow-list needs deliberate design.

## Risks

| Risk | Mitigation |
| ---- | ---------- |
| thirdweb SDK incompatible with RN 0.86 / Expo 57 or inflates the bundle | Phase 1 spike with a written go/no-go; web-first fallback; lazy-load the wallet code so logged-out and non-web3 users do not pay for it |
| Public AT repo cannot hold private content | Gated store in the brand service (Phase 4), stated honestly in the UI |
| Regulatory exposure (money transmission, KYC/AML, tax, sanctions) | Non-custodial first; counsel before Phase 3 launch |
| App-store rejection of crypto tipping or digital-goods payments | Web-first rollout; **verify** current store policies before native launch |
| Smart-contract bugs | No custom contract until needed; audit and testnet soak before mainnet |
| Wallet or DID account takeover | Dual-proof link, short-lived challenges, unlink and re-verify flow, rate limits |
| Upstream drift from Bluesky | Keep changes additive and isolated in `src/features/web3/`; merge upstream regularly; avoid editing generated lexicons |
| Trademark and asset claims | Complete the `ASSETS.md` replacement before any public launch |

## Definition of done for every step

`pnpm lint`, `pnpm typecheck`, `pnpm prettier`, `pnpm test` pass; new strings
use Lingui; new components follow `AGENTS.md` (ALF styling, `#/` imports, no
gratuitous `useMemo`); new behavior has a Jest test and, where it touches the
network, a `dev-env` or testnet check; flag-off behavior is unchanged.
