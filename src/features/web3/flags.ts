/**
 * Build-time feature flags for the Web3 layer.
 *
 * All flags default to disabled. They are read from `EXPO_PUBLIC_*` variables,
 * which are inlined into the client bundle, so they must never carry secrets.
 * With every flag off, the app must behave exactly like upstream Bluesky.
 */
export type Web3Flags = {
  /** Master switch. Every other flag is ignored while this is off. */
  web3Enabled: boolean
  /** Shows the wallet connection screen. No transactions are sent. */
  walletConnectEnabled: boolean
  /** Reserved for USDC tipping (Phase 2). Not wired to any UI yet. */
  tippingEnabled: boolean
  /** Reserved for creator access passes (Phase 4). Not wired to any UI yet. */
  subscriptionsEnabled: boolean
}

type RawFlags = {
  web3?: string
  walletConnect?: string
  tipping?: string
  subscriptions?: string
}

/**
 * Only the literal strings `true` and `1` enable a flag, so a typo or an
 * unset variable always fails closed.
 */
function isOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase()
  return v === 'true' || v === '1'
}

/**
 * Pure resolver, exported for tests. Sub-flags are forced off when the master
 * switch is off.
 */
export function resolveWeb3Flags(raw: RawFlags): Web3Flags {
  const web3Enabled = isOn(raw.web3)
  return {
    web3Enabled,
    walletConnectEnabled: web3Enabled && isOn(raw.walletConnect),
    tippingEnabled: web3Enabled && isOn(raw.tipping),
    subscriptionsEnabled: web3Enabled && isOn(raw.subscriptions),
  }
}

/*
 * `process.env.EXPO_PUBLIC_*` must be accessed with a literal property name so
 * the bundler can inline it.
 */
export const WEB3_FLAGS: Web3Flags = resolveWeb3Flags({
  web3: process.env.EXPO_PUBLIC_WEB3_ENABLED,
  walletConnect: process.env.EXPO_PUBLIC_WEB3_WALLET_CONNECT_ENABLED,
  tipping: process.env.EXPO_PUBLIC_WEB3_TIPPING_ENABLED,
  subscriptions: process.env.EXPO_PUBLIC_WEB3_SUBSCRIPTIONS_ENABLED,
})

export function useWeb3Flags(): Web3Flags {
  return WEB3_FLAGS
}
