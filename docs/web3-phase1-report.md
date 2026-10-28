# Web3 Phase 1 report: foundation

Branch `feature/web3-foundation`, based on `claude/wizardly-hawking-t2i4m8`
(which carries the Phase 0 docs). Nothing deployed, no transactions, no token,
no AT Protocol changes. All new behaviour is behind flags that default to off.

Read together with `docs/baseline.md`, `docs/architecture.md`,
`docs/web3-roadmap.md`, `web3-api/README.md` and `src/features/web3/README.md`.

## Summary

| Area                    | Result                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| Feature flags           | Done. Four flags, all default off, sub-flags need the master switch                            |
| thirdweb compatibility  | Works on **web**. Native not validated (isolated behind a stub). Three costs found (see below) |
| Wallet UI               | Done on web: all five states, tested in a real browser with a **mock** wallet                  |
| Backend `web3-api`      | Done: config, health, Postgres, migrations, validation, logging, errors, auth interface        |
| Schema                  | Six tables, three reversible migrations, tested on PostgreSQL 16                               |
| Wallet linking          | Done server-side for EOA wallets; **not yet called by the app**                                |
| Tipping / subscriptions | Types, pure rules and service interfaces only (no payments, no storage)                        |
| Existing app            | No regression found (flags-off browser run, 76/76 suites)                                      |

Two defects were found **by testing** and fixed before this report, and are
worth knowing about: the production web build ran out of memory once thirdweb
was added (it would have broken the production Docker build), and every DID
`CHECK` constraint in the first draft of the migrations was invalid in
PostgreSQL. A third design flaw (a challenge being un-consumed by a transaction
rollback) was caught in review before any test ran. See sections 3 and 7.

## 1. Files created and modified

Diff statistics against the Phase 0 tip, excluding lockfiles: **67 files, 5,323 insertions, 6 deletions**. Lockfiles add about 15,600 net lines (section 2).

**Modified (12):**

- `package.json`: `thirdweb` dependency; `web3-api/.*` added to Jest's
  `modulePathIgnorePatterns`; `build-web` now sets a 4 GB heap.
- `pnpm-lock.yaml`, `pnpm-workspace.yaml`: lockfile; `allowBuilds` entries set to
  `false` for three optional native add-ons.
- `tsconfig.json`: `web3-api` excluded from the app's type pass.
- `webpack.config.js`: wallet SDK packages added to the existing source-map
  filter (165 build warnings to 0).
- `.oxlintrc.json`: `web3-api` added to the existing override that turns off
  `import/no-nodejs-modules` for the repo's other Node-only services
  (`bskylink`, `bskyogcard`, `dev-env`).
- `.gitignore`: `bskyweb/static/media/*.wasm` and `*.cjs` (new build artefacts).
- `.env.example`: Web3 variables, all empty.
- `src/routes.ts`, `src/lib/routes/types.ts`, `src/Navigation.tsx`: the
  `WalletSettings` route (`/settings/wallet`).
- `src/screens/Settings/Settings.tsx`: a Wallet entry, rendered only when
  `walletConnectEnabled`.

**Created, app (`src/`):** `features/web3/` (`flags.ts`, `config.ts`,
`wallet/{types,store}.ts`, `wallet/adapter/{index,index.web}.ts`,
`components/WalletPanel.tsx`, two test files, `README.md`) and
`screens/Settings/WalletSettings.tsx`.

**Created, backend (`web3-api/`):** `package.json`, `pnpm-lock.yaml`,
`tsconfig.json`, `vitest.config.ts`, `.env.example`, `README.md`, three SQL
migrations, `src/` (config, errors, server, index, db, auth, wallet, payments,
subscriptions, `lexicon-ids.ts`) and `test/` (9 files plus helpers).

**Created, docs:** this report.

## 2. Dependencies added

**App (`package.json`):** `thirdweb@5.122.0` (exact pin). This adds **424
packages** to the app's lockfile (1,879 to 2,303). I checked the lockfile
programmatically: **no existing package changed version and none was removed**.
The large diff is pnpm rewriting peer-dependency suffixes on snapshot keys. It
needs careful review, but it is not a version bump of anything the app used.
Notable transitive packages: `viem`, `@walletconnect/*`, `@coinbase/wallet-sdk`,
`@base-org/account`, and a second, nested `@tanstack/react-query@5.81.5`
(thirdweb pins it; the app uses 5.100.10). The two never share a QueryClient.

pnpm flagged three optional native add-ons (`bufferutil`, `keccak`,
`utf-8-validate`); they are set to `false` (not built). They are speed-ups with
JavaScript fallbacks.

**Backend (`web3-api`, separate lockfile):** `fastify`, `@fastify/cors`, `pg`,
`node-pg-migrate`, `viem`, `zod`, `@atproto/crypto`, `@atproto/identity`,
`@atproto/xrpc-server`; dev: `typescript@~5.9`, `vitest`, `@types/node`,
`@types/pg`. No new runtime tooling: Node 24 runs the TypeScript directly.

## 3. thirdweb compatibility findings

Installed versions: React 19.2.3, React Native 0.86.0, Expo 57.0.8, Metro
0.84.4, webpack 5.106.2, `@expo/webpack-config` 19.0.1, TypeScript 6.0.2.

**Compatible (web).** thirdweb 5.122.0 declares React `^18 || ^19` and
TypeScript `>=5.0.4`; every native peer is optional. It type-checks, bundles and
connects a wallet in the web build. No framework upgrade was needed or made.

**Costs and findings:**

1. **Build memory (fixed).** `pnpm build-web` aborted with
   `JavaScript heap out of memory` at about 2 GB (exit 134), where Phase 0 had
   passed. The production `Dockerfile` runs `pnpm build-web` without a heap
   allowance, so this would have broken the image build. The project's PR
   workflow already sets `--max-old-space-size=4096`, so the same limit is now
   in the `build-web` script (an existing `NODE_OPTIONS` still wins). Rebuilt:
   exit 0 in 185 s.
2. **Bundle shape.** Main bundle `main.js`: 4,089,832 to 4,124,419 bytes
   (**+34,587, +0.85%**), mostly the feature code and a larger webpack chunk
   table. The SDK is split into about 1,145 lazy chunks (JS on disk 20.0 MB to
   24.4 MB). Verified in a browser: with flags off, **no** wallet chunk and no
   wallet-SDK request is fetched; with flags on, none is fetched until the user
   opens the wallet screen and presses Connect.
3. **Type resolution.** thirdweb's `react-native` export condition makes the
   iOS/Android type passes (which also compile `.web.ts` files) see a native
   typing of `thirdweb/wallets` that lacks the browser-only
   `getInstalledWallets`. Contained with one documented cast in
   `adapter/index.web.ts`.
4. **Source-map noise (fixed).** 165 "Failed to parse source map" warnings from
   `@base-org/account`, `@coinbase/wallet-sdk` and `@walletconnect/*`. Silenced
   with the repo's existing `patchSourceMapFilter`, scoped to those packages.
5. **Telemetry, privacy (mitigated, needs your decision).** On every connect the
   SDK POSTs `{walletAddress, chainId, walletType}` to `c.thirdweb.com` without
   asking the user. For a social network that lets a third party correlate
   wallet addresses with this site's users. The adapter redirects analytics to
   a name under the reserved `.invalid` TLD (RFC 2606), which cannot resolve; the
   SDK ignores the failure. Verified in a browser: the request is attempted
   only against that host and fails; nothing reaches thirdweb. Re-enabling is a
   product and privacy-policy decision.
6. **Native not validated.** The native adapter is a stub that never imports
   thirdweb, so iOS/Android bundles do not include it. The iOS and Android type
   passes and the iOS Jest run pass, but **a Metro native bundle was not built**
   and thirdweb's React Native path (it needs extra native modules such as
   quick-crypto and aes-gcm-crypto) was not evaluated.
7. **Other ecosystem facts.** Duplicate `@tanstack/react-query` copies (above);
   the new build artefacts `brotli_wasm_bg.*.wasm` and `index.*.cjs` appear in
   `bskyweb/static/media`, now gitignored.

**Isolation strategy used.** All wallet code sits in `src/features/web3`, loaded
by a single `import()` boundary, behind flags, web-only, with no provider added
to the app tree and no change to AT Protocol authentication.

## 4. Wallet integration status

Implemented for web (Settings, Wallet; route `/settings/wallet`). With the flag
off the route renders "Page not found".

| State                | Shown                                                           | Verified                      |
| -------------------- | --------------------------------------------------------------- | ----------------------------- |
| Disconnected         | "No wallet connected", Connect button                           | browser + unit                |
| Connecting           | spinner and prompt                                              | **unit only** (transient)     |
| Connected            | full address, network name, Disconnect                          | browser + unit                |
| Wrong network        | warning, Switch network, Disconnect; also on a mid-session change | browser + unit              |
| Failed               | specific message for: not configured, no wallet, declined, unsupported platform, unknown (with Try again) | browser + unit |

Design choices worth reviewing:

- **Connection is separate from login.** It never touches the AT session, and
  the panel says so: "Connecting a wallet does not link it to your account".
- **No signing, no transactions.** The mock wallet's RPC log shows only
  `eth_requestAccounts`, `eth_chainId`, `wallet_switchEthereumChain`,
  `wallet_revokePermissions`.
- **Full address shown**, not truncated, so look-alike addresses are visible.
- The default network is Base Sepolia. Mainnet needs the exact value
  `EXPO_PUBLIC_WEB3_NETWORK=base`.
- Wallet discovery is EIP-6963 only; it uses the first wallet found.

**Important caveat on testing:** the browser tests used a **mock** EIP-6963
wallet, not MetaMask or another real wallet, and a placeholder client ID, so
thirdweb's own services were never exercised. The not-configured state was
tested in a second build without a client ID.

## 5. Backend architecture (`web3-api`)

Standalone package (own lockfile, excluded from the app's TypeScript and Jest
runs), following the repo's own `dev-env` pattern because the root
`pnpm-workspace.yaml` defines no workspace packages. Node 24, Fastify 5,
PostgreSQL, zod. Requests are served at `/xrpc/<nsid>` so a PDS can proxy to it
with `atproto-proxy`, as the app already does for the AppView and chat.

- **Config:** validated at startup, reports names and reasons only (never
  values). `dev-insecure` auth and an http PLC are refused in production; there
  is **no default USDC address**.
- **Server:** request validation (strict zod schemas, 16 KB body limit),
  structured JSON logging with `authorization` and `x-dev-did` redacted, one
  error handler (no internals leaked; validation errors never echo input),
  CORS allow-list with no wildcard, `/health` (liveness) and `/health/ready`
  (database).
- **Auth interface:** `AuthVerifier` with two implementations: AT Protocol
  service-auth (real) and `dev-insecure` (tests only).
- **Wallet verification interface:** `WalletSignatureVerifier`; EOA
  implementation only.
- **Tipping and subscriptions:** interfaces and pure logic, no implementation.
  Private-content design is in `web3-api/README.md`.

## 6. Database migrations

`1761700000000_wallets`, `1761700000001_payments`, `1761700000002_subscriptions`:
plain SQL with `Up`/`Down`. Tables: `user_wallets`, `wallet_challenges`,
`payment_intents`, `chain_transactions`, `creator_plans`,
`subscription_entitlements`. I added a few columns beyond your list where the
design needed them (for example the stored challenge `message`, address
snapshots on `payment_intents`, `block_hash` for reorg detection).

- Amounts: `NUMERIC(78,0)` integer base units, `> 0`; read as strings and
  converted with `BigInt`.
- Uniqueness: one DID per wallet per chain; one live challenge per DID and
  wallet; unique nonce hash; unique `(chain_id, tx_hash)`; one confirmed
  transaction per intent; one entitlement per payment.
- Lowercase address/hash storage, format, status, window and duration `CHECK`s;
  self-payment and self-subscription forbidden.

Tested on PostgreSQL 16.15: up, up again (no-op), down three times, up again.
The first draft failed here: all seven DID constraints used `{1,2000}`, which
PostgreSQL's regex engine rejects (maximum repeat 255) at insert time. Fixed
before anything was merged anywhere. Note PostgreSQL silently **rounds** a
fractional value written to a scale-0 `NUMERIC`, so fractional amounts must be
rejected in application code (`parsePositiveTokenAmount` does).

## 7. Authentication and wallet-linking security

**AT Protocol authentication, tested against a real PDS.** A local network
(`dev-env`) was started, a real PDS minted tokens with
`com.atproto.server.getServiceAuth`, and the verifier resolved the DID from a
real PLC directory. This was tested because a locally forged-key test had passed
while the real flow initially **failed**: `@atproto/identity` refuses plain
`http:` (its SSRF protection), and the local PLC is http. Resolved with an
explicit, narrow dev-only option (`ALLOW_INSECURE_PLC`): it permits http to the
single configured PLC origin only, is off by default, and is refused in
production. Production keeps the SSRF-protected fetch and `https://plc.directory`.
Observed token facts: ES256K, `iss` is the DID, **expires 60 seconds after
issue**, so clients need a fresh token per call.

**Not tested:** the proxy path through a user's PDS (`atproto-proxy:
did:web:...#service`), which needs this service to publish a DID document with a
service entry. Use a direct call with a `getServiceAuth` token until it is
verified.

**Linking flow and guarantees** (each is covered by a test):

- Challenge is an EIP-4361 (SIWE) message bound to **domain, chain, nonce, expiry
  and the authenticated DID**; TTL 5 minutes by default (30 s to 15 min).
- **Single use and replay-safe.** The challenge is consumed by one conditional
  `UPDATE`, committed **before** signature work, so any attempt burns it.
  Twenty concurrent consumes yield exactly one winner against real Postgres.
  (A first design consumed it inside the verification transaction, so a failed
  signature would have rolled the consumption back and left it retryable. This
  was found in review and fixed.)
- **No duplicate challenges:** a partial unique index plus supersede-on-issue.
- **No unauthorised reassignment:** `UNIQUE (chain_id, wallet_address)`; two DIDs
  racing for one wallet yield one winner and a 409 (tested at the service and
  database level). Unlinking is not implemented.
- A wallet is never recorded without a successful **server-side** signature
  check. A signature from another wallet, another DID's challenge, an expired
  challenge, or a different domain is rejected.
- Only the nonce **hash** is stored. All failures that reveal challenge state are
  indistinguishable to the caller. Logs were checked: no tokens, auth headers or
  signatures.

**Limitation:** EOAs only. Longer signatures (ERC-1271/6492: smart-contract
wallets, which includes thirdweb in-app and smart accounts) are refused with
`422 unsupported_signature_type`, not guessed at.

## 8. Tests executed and exact results

All of these actually ran, in this session, on Node 24.22.1 and pnpm 11.23.0.

**App**

| Command           | Result                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- |
| `pnpm lint`       | exit 0 (note: this script lints `src` and `modules` only, not `web3-api`; see below)    |
| `oxlint web3-api` | exit 0, no warnings (run by the pre-commit hook; see below)                             |
| `pnpm typecheck`  | exit 0 (ios, android, web)                                                              |
| `pnpm test`       | **76 suites passed, 858 tests passed, 28 todo, 21 snapshots, 0 failed** (Phase 0: 74 / 840) |
| `pnpm build-web`  | first attempt **failed**, exit 134 (out of memory); after the fix exit 0, 185 s         |
| `pnpm prettier`   | exit 0: "All matched files use Prettier code style!"                                     |

New app tests: 2 suites, 18 tests (flags and network resolution; the wallet store
through every state, retry, wallet-initiated disconnect and chain changes).

**Lint coverage gap, found by the pre-commit hook.** `pnpm lint` only covers
`src` and `modules`, so it never looked at `web3-api`. The repo's pre-commit hook
(`lint-staged` running `oxlint --fix` on staged files) did, and blocked the
backend commit with 20 findings: Node built-in imports (fixed by the override
above), inline type specifiers, a named `pg` import, an unused variable, an
`async` function without `await`, untyped `any` access in tests, and import
order. All were fixed in the code; the hook was **not** bypassed. One fix
mattered: the type-aware linter's autofix removed `as Hex` casts that this
package's `tsc` needs, which would have re-broken the build on every commit, so
the test hashes are now built with `keccak256` and need no cast. Because runtime
code changed afterwards (`pg` imports), the live PostgreSQL and PDS suites were
re-run: still 115 of 115.

**Backend (`web3-api`)**

| Run                                         | Result                                   |
| ------------------------------------------- | ---------------------------------------- |
| `tsc --noEmit`                              | clean                                    |
| With PostgreSQL 16 and a live PDS           | **9 files, 115 tests passed**            |
| With no external services (like CI would)   | 7 files passed, 2 skipped; 91 passed, **24 skipped** |
| Migrations via the CLI                      | up, up again (no-op); down x3 and up (in tests) |

**Live end-to-end** (real PDS tokens, running server, real Postgres): 13 of 13
checks passed, including no token, garbage token, a PDS access token, a token
for another method, a stolen challenge, replay, claiming another DID's wallet,
and validation without echoing input.

**Browser (headless Chromium, local `dev-env` backend)**

| Scenario                                           | Checks |
| -------------------------------------------------- | ------ |
| Flags **off**: login, feed, publish, notifications, profile, no Wallet entry, direct URL is Not Found, no wallet requests or chunks | 8 of 8 |
| Flags **on**: all wallet states, no signing methods, lazy loading, no telemetry egress | 22 of 22 |
| Flags on, **no client ID**: not-configured state   | 4 of 4 |

`http://localhost:19006/` served the app in all three configurations; zero page
errors. The dev build compiles with 0 warnings.

Not run: Maestro E2E, native builds, a Metro native bundle, any test with a real
wallet extension or a real thirdweb client ID. The browser and live-flow
scripts used for the scenarios above are not committed to the repository.

## 9. Remaining limitations

- Web only; the native app shows "web app only". thirdweb on React Native is
  unevaluated.
- The app does not yet call `web3-api`; there is no link/unlink UI and no
  `buildBrandClient`. Wallet connection and linking are separate on purpose.
- Linking supports EOAs only; no wallet picker, WalletConnect, in-app or smart
  wallets.
- Only mock-wallet browser tests; no real wallet and no real thirdweb project.
- The PDS-proxy authentication path is untested.
- `app.web3.*` NSIDs are placeholders and must be replaced under a domain you
  own.
- Missing hardening: no rate limiting, no cleanup job for expired challenges, no
  unlink or admin endpoints, no deployment, no CI job for `web3-api`.
- Clock: challenge expiry uses the application clock, so skew between instances
  would matter at scale.
- The USDC address is deliberately unset; no on-chain check of `decimals()` or
  `symbol()` exists yet.
- The app's lockfile diff is large (peer-suffix rewrites) and the dependency
  footprint grew by 424 packages: review supply-chain policy.
- Telemetry stays disabled until a privacy decision is made.
- A production CSP is still absent (`bskyweb` sets only
  `X-Content-Type-Options` and `X-Frame-Options`); wallet SDKs will need one.

## 10. Recommended Phase 2 tasks (waiting for your approval)

1. Decide EOA-only linking versus smart-contract wallets (needs ERC-1271/6492
   verification through an RPC provider).
2. Wire the app: `buildBrandClient`, link flow (challenge, `signMessage`,
   verify), list and unlink with its own authorisation, and a wallet picker.
3. Prove the PDS proxy path (DID document with a service entry) or settle on
   direct service-auth calls.
4. Harden `web3-api`: rate limits, challenge cleanup, CI job with a Postgres
   service, replace placeholder NSIDs, deploy plan.
5. USDC on Base: confirm the address from the issuer's documentation, add a
   startup check of `decimals()` and `symbol()`, implement `ChainReader` and the
   `TippingService` (idempotent, reorg-aware), a reconciliation worker, then the
   tip dialog. Test on Base Sepolia only until reviewed.
6. Test with real wallets (MetaMask, Coinbase) and a real thirdweb project.
7. Privacy and security review (telemetry, RPC provider exposure, CSP), then
   legal review before any real funds.
8. Decide the native strategy (spike the React Native path, or stay web-first).

Phase 2 (USDC tipping) has **not** been started.
