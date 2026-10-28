# Web3 feature

Opt-in wallet support, layered on top of the unchanged AT Protocol app. With
every flag off, the app behaves exactly like upstream: the route exists but
renders "Page not found", Settings shows no wallet entry, and the wallet SDK is
never downloaded or contacted.

## Flags

Build-time, read from `EXPO_PUBLIC_*` (so they are public; never put secrets in
them). Only `true` or `1` enables a flag. Everything defaults to off.

| Flag                   | Variable                                  | Effect today                           |
| ---------------------- | ----------------------------------------- | -------------------------------------- |
| `web3Enabled`          | `EXPO_PUBLIC_WEB3_ENABLED`                | Master switch; all others need it      |
| `walletConnectEnabled` | `EXPO_PUBLIC_WEB3_WALLET_CONNECT_ENABLED` | Settings > Wallet (connect/disconnect) |
| `tippingEnabled`       | `EXPO_PUBLIC_WEB3_TIPPING_ENABLED`        | Reserved (Phase 2), no UI              |
| `subscriptionsEnabled` | `EXPO_PUBLIC_WEB3_SUBSCRIPTIONS_ENABLED`  | Reserved (Phase 4), no UI              |

Other variables: `EXPO_PUBLIC_WEB3_NETWORK` (`base` for mainnet; anything else,
including unset, means Base Sepolia, so a typo can never select mainnet) and
`EXPO_PUBLIC_THIRDWEB_CLIENT_ID` (public by design; the thirdweb **secret** key
belongs only in the backend).

## What exists

- `flags.ts`, `config.ts`: flags, target network, client id.
- `wallet/types.ts`: `WalletState` (`disconnected`, `connecting`, `connected`,
  `wrong_network`, `failed`), the adapter interface, `WalletError`.
- `wallet/store.ts`: small external store (no provider added to the app tree).
  Wallet state is in memory only.
- `wallet/adapter/index.web.ts`: thirdweb, loaded with dynamic `import()` only
  when the user presses Connect, so it sits in its own chunks.
- `wallet/adapter/index.ts`: native stub (`unsupported_platform`). The native
  bundles never import thirdweb.
- `components/WalletPanel.tsx`, `../../screens/Settings/WalletSettings.tsx`: UI.

## Rules

- **A connected wallet is not a verified owner.** Wallet connection is
  independent of AT Protocol login and never touches the session. Linking a
  wallet to a DID happens only through the signed challenge flow in
  `web3-api/README.md`, which the app does not call yet.
- The wallet UI **never requests a signature or a transaction.** Only
  `eth_requestAccounts`, `eth_chainId`, `wallet_switchEthereumChain` and
  `wallet_revokePermissions` are used.
- The full address is displayed, not a truncated form, to make look-alike
  ("address poisoning") substitutions visible.
- thirdweb telemetry is disabled in the adapter. By default the SDK posts the
  wallet address, chain and wallet type to `c.thirdweb.com` on connect. It is
  redirected to a name under the reserved `.invalid` TLD. Re-enable only after
  a privacy review.

## Platform support

Web only in Phase 1. thirdweb's React Native support needs extra native modules
that have not been validated against this app's React Native 0.86 / Expo 57.
Native shows "available on the web app only".
