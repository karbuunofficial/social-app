# Baseline: setup, test results, known issues

Recorded 2026-10-28 on commit `2bfb94d` (app version 1.133.0), before any
feature work. Nothing in the repository was modified to get these results.

## Environment

|           | Required (`package.json`) | Used                    |
| --------- | ------------------------- | ----------------------- |
| Node      | `>=24.19.0`               | 24.22.1                 |
| pnpm      | 11.23.0                   | 11.23.0                 |
| Go        | see `bskyweb/go.mod`      | 1.26.0 (auto-downloaded) |

The host shipped Node 22.22 and pnpm 10.28, both too old. Node 24 and pnpm 11
were installed into a throwaway directory and put on `PATH`, so no global tool
was changed. (pnpm's `devEngines` auto-download of Node was not tested.)

## Result summary

| Check                      | Command                       | Result                                                     |
| -------------------------- | ----------------------------- | ---------------------------------------------------------- |
| Install                    | `pnpm install --frozen-lockfile` | pass, lockfile passes supply-chain policy               |
| Lint                       | `pnpm lint`                   | pass, exit 0                                               |
| Typecheck (ios/android/web) | `pnpm typecheck`             | pass, exit 0                                               |
| Prettier                   | `pnpm prettier`               | pass ("All matched files use Prettier code style!")        |
| Unit tests                 | `pnpm test`                   | pass: 74/74 suites, 840 passed, 28 todo, 21 snapshots, 71s |
| Production web build       | `pnpm build-web`              | pass, with webpack size-limit warnings (see below)         |
| Go server tests            | `cd bskyweb && go test ./...` | pass after `build-web`; see failure 1                      |
| Go server build + smoke    | `go build ./cmd/bskyweb`      | pass; `/` and `/robots.txt` return 200                     |
| Dev server                 | `pnpm web`                    | pass; renders at http://localhost:19006                    |
| Authenticated flows        | local `dev-env` backend       | pass, see below                                            |

Not run: Maestro E2E (`pnpm e2e:*`, needs an iOS simulator or Android
emulator), native builds (`pnpm ios` / `pnpm android`), `pnpm lexicons:verify`.

### Exact failures observed

1. **`go test ./...` on a fresh checkout**

   ```
   static.go:5:12: pattern static/*: cannot embed directory static/css: contains no embeddable files
   FAIL github.com/bluesky-social/social-app/bskyweb [setup failed]
   ```

   Cause: the Go server embeds the web bundle. Not a code defect. Run
   `pnpm build-web` first (as `docs/build.md` says); the same tests then pass.

2. **`pnpm web --port 19006` after a previous run** reported
   `Port 19006 is running this app in another window` and exited
   (`Input is required, but 'npx expo' is in non-interactive mode`) although
   nothing was listening. Starting without `--port` worked. Treat as a stale
   Expo port-detection quirk.

3. **Production build warnings** (not failures): `asset size limit` and
   `entrypoint size limit` (recommended 586 KiB). The web bundle is large
   before any wallet SDK is added; budget for this in the thirdweb work.

### Console noise on the dev server (not defects)

- CORS blocks for `app-config.workers.bsky.app`, `live-events.workers.bsky.app`
  and `ip.bsky.app/geolocation` from `localhost`. These are Bluesky-owned
  services; `.env.example` has `APP_CONFIG_DEV_URL`, `LIVE_EVENTS_DEV_URL` and
  `GEOLOCATION_DEV_URL` overrides for forks.
- `Could not parse Expo config: android.googleServicesFile` (native only; copy
  `google-services.json.example`, per `docs/build.md`).
- Expo tries to install React Native DevTools (Electron) and fails when run as
  root. Harmless.
- A webpack HMR websocket error appears under `CI=1`.
- Expo reports `expo` 57.0.8 has a newer patch (57.0.31) available.

## What was exercised in the browser

Logged out, against the public Bluesky network (read-only; no account created):
welcome modal, Discover feed with images, trending, public profile
(`/profile/bsky.app`), sign-in form with the hosting-provider picker.

Logged in, against a local throwaway AT Protocol network (see below):
login with a manually entered hosting provider, age-assurance gate, Following
feed, publishing a text post (appeared in the feed and on the profile),
notifications ("followed you back"), own profile.

**Not exercised:** image and video upload, chat/DMs, push notifications,
custom feeds beyond Discover, moderation, native apps. Media and chat code were
read, not run.

## Running a local AT Protocol backend (no Bluesky account needed)

`dev-env/` wraps `@atproto/dev-env` (PDS, PLC directory and AppView in one
process). `pnpm e2e:mock-server` expects Docker for Postgres and Redis. Where
Docker is unavailable:

1. Start Postgres on `5433` (user `pg`, password `password`) and Redis on
   `6380`. Postgres refuses to run as root, so use an unprivileged user.
2. `cd dev-env && pnpm install && pnpm start:external`
3. Seed: `curl -X POST "localhost:1986/?users&follows&posts&feeds"`
   (creates `alice.test`, `bob.test`, `carla.test`, all with password
   `hunter2`; PDS at `http://localhost:3000`).
4. `EXPO_PUBLIC_BLUESKY_PROXY_DID=did:plc:bw7ad3erl7btq6qwf66yqiov pnpm web`
   (this DID is `E2E_APPVIEW_DID` in `dev-env/constants.ts`).
5. Sign in, "Change hosting provider", Manual, `http://localhost:3000`.

Gotchas:

- The seeded accounts have no birthdate, so the app shows the age-assurance
  gate until one is saved.
- Chat is unavailable locally: `chat.bsky.convo.getLog` returns 401 (`could not
  resolve iss did`) because the chat proxy DID is `did:web:api.bsky.chat`.
- The AppView listens on `3002` here; `2584` is only its advertised public URL.
- If Postgres dies mid-session, the PDS answers `502` for every proxied appview
  call and the dev overlay shows an uncaught `XrpcResponseError`. Restart the
  stack rather than debugging the app.
