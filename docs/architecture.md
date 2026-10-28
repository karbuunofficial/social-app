# Architecture

A map of the app as it exists today, for people building on this fork. File
paths are relative to the repo root. Statements marked _(inferred)_ were not
verified by running code.

## Stack

React 19.2 and React Native 0.86 on Expo 57, one codebase for iOS, Android and
web (react-native-web 0.21). TypeScript, TanStack Query 5, Lingui 5, React
Navigation 7, and the in-house ALF design system (`src/alf`). The AT Protocol
client is `@atproto/lex` (not `@atproto/api`) plus
`@atproto/lex-password-session`. Generated lexicon types are in `src/lexicons`
(`pnpm lexicons:generate` runs in `postinstall`).

Web is built by webpack (`webpack.config.js`, `@expo/webpack-config`), served
in dev at `:19006`. Native uses Metro. _(inferred)_ `@expo/webpack-config` is
the legacy Expo web path, so check its compatibility before adding large
dependencies.

## Repository layout

| Path                          | Role                                                            |
| ----------------------------- | --------------------------------------------------------------- |
| `src/`                        | The app (see below)                                             |
| `modules/`                    | Native Expo modules (Swift/Kotlin)                              |
| `bskyweb/`                    | Go server that serves the built web app and OG/meta templates   |
| `bskylink/`, `bskyogcard/`, `bskyembed/`, `Dockerfile.*` | Separate small services: link redirects, OG images, embeds |
| `dev-env/`                    | Local mock AT Protocol network used by Maestro E2E              |
| `__e2e__/`, `__tests__/`      | Maestro flows; Jest tests (most Jest tests sit next to source)  |
| `lexicons/`, `lexicons.json`  | Vendored lexicon schemas                                        |
| `docs/`, `AGENTS.md`          | Contributor docs and coding rules                               |

Inside `src/`: `alf/` (design system), `components/` (shared UI),
`screens/` (new-style screens), `view/` (legacy screens and components; avoid
adding here), `features/` (macro features), `state/` (queries, preferences,
session, persisted storage), `lib/` (utilities, API helpers), `locale/`,
`env/`, `Navigation.tsx`, `routes.ts`.

## Runtime topology

```
 Browser / iOS / Android  (this repo)
        |
        |  XRPC over HTTPS, atproto-proxy header selects the target service
        v
   User's PDS  ------------------------------------------------+
   (bsky.social by default; any PDS via "hosting provider")     |
        |  proxied calls, PDS mints service-auth JWTs           |
        +--> AppView    did:web:api.bsky.app#bsky_appview       |
        +--> Chat       did:web:api.bsky.chat#bsky_chat         |
                                                                |
   Direct from client (not via PDS):                            |
     video.bsky.app (video upload/processing), gifs.bsky.app,   |
     cardyb.bsky.app (link cards), public.api.bsky.app          |
     (logged-out reads), *.workers.bsky.app (config, geo,       |
     live events), events.bsky.app (metrics)                    |
```

Everything above the line the user "owns" is the PDS repo (posts, likes,
follows, profile, lists). Everything derived (feeds, counts, notifications,
search, threads) is computed by the AppView. This matters for monetization:
see `docs/web3-roadmap.md`.

## Auth and session (`src/state/session/`)

- Password-based sessions via `PasswordSession` (not OAuth). Account creation
  is `create-account.ts`; session lifecycle is `session-core.ts` and
  `reducer.ts`; React integration and multi-account handling is `index.tsx`.
- Three Lex clients are built per session in `clients.ts`:
  - `buildAppviewClient` sets `atproto-proxy: ${BLUESKY_PROXY_DID}#bsky_appview`
  - `buildPdsClient` has no proxy header (repo, server and identity calls)
  - `buildChatClient` proxies to `${CHAT_PROXY_DID}#bsky_chat`
- This proxy-header pattern is the existing, supported way to add another
  service. A new brand service can follow it (see roadmap).
- The app already mints `com.atproto.server.getServiceAuth` tokens for the
  video service (`getServiceAuthToken` in `src/lib/media/video/upload.shared.ts`)
  and for age assurance. That is the precedent for authenticating a user to a
  custom service by DID without a new login.
- The login form (`src/screens/Login`) supports a custom hosting provider, so
  the client already works against any PDS. `DEFAULT_SERVICE` is
  `https://bsky.social` in `src/lib/constants.ts`.
- Logged-out mode reads from `PUBLIC_BSKY_SERVICE` (`public.api.bsky.app`),
  wired in `session-core.ts`; `LoggedOutViewProvider` only controls the UI.
- Accounts lacking a birthdate hit an age-assurance gate before any content.

## Configuration

`EXPO_PUBLIC_*` variables are read in `src/env/common.ts` and inlined into the
client bundle, so they are public. Notable: `EXPO_PUBLIC_BLUESKY_PROXY_DID`
(default `did:web:api.bsky.app`), `EXPO_PUBLIC_CHAT_PROXY_DID` (default
`did:web:api.bsky.chat`), metrics, GrowthBook, Sentry, Bitdrift, and the three
`*_DEV_URL` overrides. `.env` and `.env.*` are gitignored. Never put a secret in
an `EXPO_PUBLIC_*` variable.

## Hard-coded Bluesky dependencies

`src/lib/constants.ts` holds most of them: `BSKY_SERVICE`, `PUBLIC_BSKY_SERVICE`,
`PUBLIC_APPVIEW`, `CHAT_SERVICE`, `VIDEO_SERVICE` and `VIDEO_SERVICE_DID`,
`GIF_SERVICE`, `PROD_LINK_META_PROXY`, `EMBED_SERVICE`, `STATUS_PAGE_URL`,
`HELP_DESK_URL`, `BSKY_DOWNLOAD_URL`, plus Bluesky-owned DIDs and feed URIs
(`BSKY_APP_ACCOUNT_DID`, default Discover and "whats-hot" generators,
`TRENDING_DID`, moderation authorities, a `DISCOVER_DEBUG_DIDS` list). App identity
lives in `app.config.js` (`name`, `slug`, `scheme`, `owner`, iOS bundle id
`xyz.blueskyweb.app`, associated domains, EAS `projectId`), `web/index.html`,
and `bskyweb/templates/*.html`.

About 277 source files mention "bsky" or "Bluesky". Most are lexicon NSIDs
(`app.bsky.*`, `chat.bsky.*`) which are protocol identifiers, not branding.
**Do not search-and-replace them.**

## Feature areas

**Feeds.** `src/lib/api/feed/` has one class per feed type (`home`,
`following`, `custom`, `author`, `likes`, `list`) behind the `FeedAPI`
interface, merged and de-duplicated in `merge.ts` and `feed-manip.ts`.
`src/state/queries/post-feed.ts` exposes them through `usePostFeedQuery`
(`useInfiniteQuery`, cursor paging) with the feed-descriptor string as key.
Screens: `src/screens/Home`, `CustomFeed`, `Feeds`, `SavedFeeds`.

**Profiles.** `src/screens/Profile`, queries in `src/state/queries/profile*.ts`
and `unstable-profile-cache.ts`. Routes `/profile/:name[/...]`.

**Posting.** `src/view/com/composer/` is the composer UI (text input, photos,
videos, GIFs, threadgate, labels, drafts). `post()` in `src/lib/api/index.ts`
builds `app.bsky.feed.post`, resolves reply/quote/embeds, uploads blobs, and
commits everything in one `com.atproto.repo.applyWrites` call (post plus
optional threadgate and postgate records) through the PDS client.

**Media.** Images are blobs uploaded to the PDS (`src/lib/api/upload-blob.ts`,
with a `.web.ts` variant). Video goes to `VIDEO_SERVICE`
(`src/lib/media/video/`), authenticated with a service-auth token. GIFs use
`gifs.bsky.app`; link previews use `cardyb.bsky.app`.

**Notifications.** In-app list and unread badge in
`src/state/queries/notifications/` (`feed.ts`, `unread.tsx`, `settings.ts`),
the screen in `src/screens/Notifications`, and push registration in
`src/lib/notifications/` (expo-notifications). The list comes from the AppView
(`app.bsky.notification.listNotifications`), so it only contains notification
reasons the AppView knows about.

**Chat.** `src/state/messages/`, `src/screens/Messages`, proxied to the chat
service.

**Moderation.** Labelers and moderation prefs: `src/lib/moderation*`,
`src/state/session/moderation.ts`, `src/screens/Moderation*`.

**State.** Server state in TanStack Query (`src/state/queries`, keys built with
`createQueryKey`); UI preferences in React Context
(`src/state/preferences`); persisted storage in `src/state/persisted` and
`src/storage`.

## Provider tree (`src/App.web.tsx`, native is analogous)

Outer to inner: Geo, AppConfig, KeyboardController, Onboarding, Session,
PrefsState, ShellState, DialogState, LightboxState, Portal, Landing; then Alf
(theme), ThemeProvider, ContextMenu, video providers, Query, PolicyUpdate,
LiveEvents, Composer, Messages, LabelDefs, ModerationOpts, LoggedOutView,
SelectedFeed, HiddenReplies, HomeBadge, UnreadNotifs, MutedThreads,
SafeArea, ProgressGuide, ServiceConfig, EmailVerification, Hotkeys, and
finally `<Shell />`. A wallet provider would sit below Session and Query
because it needs the current DID and may issue queries.

## Navigation

`src/routes.ts` maps screen names to URL patterns; `src/Navigation.tsx`
registers screens; param types are in `src/lib/routes/types.ts`. Settings
lives under `/settings/*` (`src/screens/Settings`).

## Tests

Jest (`pnpm test`, 74 suites): session, queries, feed manipulation, moderation,
string and URL helpers. Native-only code is mocked in `jest/` and `__mocks__/`.
Maestro flows in `__e2e__/flows` cover login, onboarding, composer, profile,
lists, moderation, and threads against `dev-env`. There are no tests of the web
bundle itself or of anything wallet-related.

## What does not exist yet

No wallet, no blockchain library (`wagmi`, `viem`, `ethers`, `thirdweb`: none
in `package.json` or `src`), no payments, no custom backend service, no
PostgreSQL usage in this repo (only the `dev-env` test harness uses it).
