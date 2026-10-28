# web3-api

Application-specific backend for the Web3 layer: wallet linking, and the
foundations for USDC tipping and creator access passes. It sits **beside** the
AT Protocol stack and never replaces it. Identity, repos, feeds and the social
graph stay on the user's PDS and the AppView.

Status: **Phase 1 foundation. Not deployed.** Only wallet linking is wired to
routes. Tipping and subscriptions are types, pure rules and service interfaces
with no implementation and no payments.

Standalone package (like `../dev-env`): it has its own `package.json` and
lockfile and is not part of the app's install.

## Stack

Node.js 24 (runs TypeScript directly via type stripping, so no build step; code
avoids enums and constructor parameter properties, enforced by
`erasableSyntaxOnly`), Fastify 5, PostgreSQL via `pg`, SQL migrations via
`node-pg-migrate`, `zod` for validation, `viem` for signatures and SIWE,
`@atproto/xrpc-server` + `@atproto/identity` for AT Protocol service auth.

## Layout

```
migrations/            plain SQL, "-- Up Migration" / "-- Down Migration"
src/config.ts          env validation (fails fast, never echoes values)
src/errors.ts          AppError + one error handler (no internals leaked)
src/server.ts          Fastify app: logging w/ redaction, CORS allow-list, health
src/auth/              AuthVerifier interface + AT Protocol service-auth verifier
src/wallet/            SIWE challenge/response, signature verifier, pg repository
src/payments/          USDC on Base: amounts, chain config, ERC-20 prep, receipt
                       verification and reorg rules (pure; no service impl yet)
src/subscriptions/     plan/entitlement types, access rules, service interface
test/                  unit, route, Postgres and live-PDS integration tests
```

## Run locally

```bash
cd web3-api
pnpm install
cp .env.example .env          # edit; never commit .env
pnpm migrate                  # applies migrations (use `pnpm migrate down` to revert one)
pnpm start                    # http://127.0.0.1:8787
```

Needs a PostgreSQL you control. `GET /health` is liveness;
`GET /health/ready` checks the database.

## Configuration

All variables are validated at startup (`src/config.ts`); see `.env.example`.
Notable rules:

- `AUTH_MODE=dev-insecure` (trusts an `x-dev-did` header) is **refused** when
  `NODE_ENV=production`.
- `PLC_URL` must be `https` unless `ALLOW_INSECURE_PLC=true`, which is also
  refused in production. It exists only to use a local plain-http AT Protocol
  network.
- `USDC_ADDRESS_<chainId>` has **no default**. Take the address from the token
  issuer's official documentation and confirm it on-chain. Mixed-case values
  must have a valid EIP-55 checksum. Tipping code refuses to run without it.
- `ALLOWED_CHAIN_IDS` accepts only Base (8453) and Base Sepolia (84532).
  The default is Base Sepolia only.

## API

Requests are served at `/xrpc/<nsid>` so a user's PDS can later proxy to this
service with the `atproto-proxy` header, the mechanism the app already uses for
the AppView and chat. `app.web3.*` is a **placeholder namespace** (see
`src/lexicon-ids.ts`); replace it with a reverse-DNS name under a domain the
project owns before any public deployment.

| Method | NSID                                | Purpose                            |
| ------ | ----------------------------------- | ---------------------------------- |
| POST   | `app.web3.wallet.createChallenge`   | Issue a single-use SIWE challenge  |
| POST   | `app.web3.wallet.verifyChallenge`   | Verify signature, link the wallet  |
| GET    | `app.web3.wallet.listWallets`       | List the caller's verified wallets |

Errors are `{"error": {"code", "message"}}`. Validation errors list field paths
and reasons only, never the submitted values.

## Authentication

Callers authenticate as an AT Protocol DID with a **service-auth JWT**: the
user's PDS mints it via `com.atproto.server.getServiceAuth` (audience = this
service's `SERVICE_DID`, `lxm` = the NSID being called). The verifier checks the
signature against the DID document's signing key, expiry, audience and `lxm`.
Any failure is reported identically as 401.

Observed against a real PDS (`@atproto/dev-env`): tokens are ES256K, carry
`iss` (the DID, no fragment), `aud`, `lxm`, `jti` and **expire 60 seconds** after
issue, so clients must request a fresh token per call.

This flow was tested end to end against a real PDS and PLC directory
(`test/atproto-service-auth.integration.test.ts`). **Not yet tested:** the PDS
proxy path (`atproto-proxy: did:web:...#service` through a user's PDS), which
needs this service to publish a DID document with a service entry. Until that
is verified, clients should call this service directly with a token from
`getServiceAuth`.

## Wallet linking

```
user (logged in)       web3-api                         wallet
   | service-auth JWT     |                               |
   |--createChallenge---->| verify JWT -> DID             |
   |   {address, chain}   | one live challenge per        |
   |                      | (DID, address); supersede old |
   |<--{id, SIWE message}-| store nonce HASH + message    |
   |                      |                               |
   |-------------- sign message ------------------------->|
   |<------------------------ signature ------------------|
   | service-auth JWT     |                               |
   |--verifyChallenge---->| consume challenge (atomic,    |
   |  {id, signature}     |   committed, BEFORE checking) |
   |                      | check domain, nonce hash,     |
   |                      |   chain, address, DID, expiry |
   |                      | recover signer == address     |
   |                      | insert link (unique per chain)|
   |<--wallet (201)-------|                               |
```

Properties, each covered by tests:

- **Authenticated DID.** Challenges are bound to the DID from the verified JWT
  and embedded in the signed message (`resources`), together with the domain
  (`SIWE_DOMAIN`, the host of `WEB_APP_ORIGIN`), chain id, nonce and expiry
  (default 5 minutes, max 15).
- **Single use / replay.** The challenge is consumed by one conditional `UPDATE`
  that is committed **before** signature work, so any attempt, successful or
  not, burns it. A failed attempt needs a new challenge. Concurrent attempts:
  exactly one wins.
- **No duplicate challenges.** A partial unique index allows one live challenge
  per DID and wallet; issuing a new one supersedes the old.
- **No unauthorised reassignment.** `UNIQUE (chain_id, wallet_address)`. A wallet
  linked to one DID cannot be linked to another; two DIDs racing for one wallet
  produce one winner and a 409. Unlinking is not implemented (Phase 2) and will
  need its own authorisation.
- **Server-side verification only.** A wallet is never recorded as verified
  without a successful signature check on the server.
- **Nonce hygiene.** Only a SHA-256 of the nonce is stored.
- **Indistinguishable failures.** Unknown, foreign, expired and used challenges
  all return the same error.

Limitation: only **externally owned accounts** (EOAs) are supported. Signatures
longer than 65 bytes (smart-contract wallets: ERC-1271/ERC-6492, which includes
thirdweb in-app and smart accounts) are refused with `422
unsupported_signature_type` rather than guessed at. Supporting them needs an
on-chain verification call and is Phase 2.

## Database

Migrations `1761700000000` to `1761700000002` create `user_wallets`,
`wallet_challenges`, `payment_intents`, `chain_transactions`, `creator_plans`
and `subscription_entitlements`. Highlights:

- Token amounts are `NUMERIC(78,0)` (fits uint256) holding **integer base
  units**. `pg` returns them as strings; code converts with `BigInt` and never
  uses JavaScript numbers for money. Check constraints require amounts > 0.
  Note that a fractional value written to a scale-0 `NUMERIC` is rounded by
  PostgreSQL, so validation must happen in application code
  (`parsePositiveTokenAmount` rejects it).
- Formats (DIDs, addresses, hashes), status sets, windows and durations are
  enforced with `CHECK` constraints; addresses and hashes are stored lowercase.
- `UNIQUE (chain_id, tx_hash)` gives duplicate-event protection; one confirmed
  transaction per payment intent; one entitlement per payment.
- No private keys, recovery phrases or signing secrets are stored anywhere.
- Never edit a migration that has been applied to a shared database. Add a new
  one.

## Tipping and subscriptions (interfaces only)

`src/payments` and `src/subscriptions` contain pure, tested logic and service
interfaces; nothing sends a transaction or moves funds.

- `parsePositiveTokenAmount` / `formatTokenAmount`: bigint decimal handling.
- `buildChainConfigs`, `requireUsdcAddress`: per-chain config; no default token
  address.
- `prepareUsdcTransfer`: builds an **unsigned** ERC-20 `transfer` request.
- `evaluateTransaction`, `hasMatchingTransfer`, `nextTransactionStatus`:
  receipts are judged by their `Transfer` logs (exact sender, recipient, token
  and amount; exactly one match), with confirmation depth, and reorg detection
  by recorded block hash. `confirmed -> reorged` is a legal transition and must
  trigger revocation of anything granted from it.
- `grantWindow`, `authorizeAccess`: time-limited passes with no automatic
  renewal; a renewal queues after the running pass.

### Keeping subscriber content private

AT Protocol repositories are public and mirrored by relays and AppViews, so
subscriber-only content must **never** be written to a user's repo. The design:

1. The public record is only a teaser post (an ordinary `app.bsky.feed.post`).
2. The private body or media lives in this service's storage (Postgres or
   object storage), encrypted at rest, keyed by creator and content id.
3. Every read goes through an authenticated endpoint that verifies the caller's
   DID (service auth) and then calls `authorizeAccess`. The decision is made
   server-side on every request, from stored entitlements, and never from a
   client-supplied claim.
4. Media is served through short-lived, per-request signed URLs, not permanent
   public links.
5. Revocation and expiry take effect on the next request.

Not implemented in Phase 1: content storage, entitlement persistence, payments.

## Tests

```bash
pnpm test           # unit + route tests; integration tests are skipped without env
pnpm typecheck

# Postgres integration (uses a DISPOSABLE database; it migrates down and up):
TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/web3_test pnpm test

# Real PDS service-auth flow against a local AT Protocol network (../dev-env):
ATPROTO_PDS_URL=http://localhost:3000 ATPROTO_PLC_URL=http://localhost:3001 \
ATPROTO_TEST_IDENTIFIER=alice.test ATPROTO_TEST_PASSWORD=<password> pnpm test
```

Signing tests use throwaway keys generated in memory per run. No key material is
stored in the repository.
