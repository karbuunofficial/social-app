import {
  type WalletAdapter,
  WalletError,
  type WalletSnapshot,
} from '#/features/web3/wallet/types'

/**
 * Native placeholder. Phase 1 supports wallet connection on web only: the
 * thirdweb React Native path needs extra native modules and has not been
 * validated against this app's React Native and Expo versions. Because this
 * file never imports thirdweb, the native bundles are unaffected by the SDK.
 */
const adapter: WalletAdapter = {
  isSupported: false,
  connect(): Promise<WalletSnapshot> {
    return Promise.reject(new WalletError('unsupported_platform'))
  },
  disconnect: () => Promise.resolve(),
  switchNetwork: () => Promise.resolve(),
  subscribe: () => () => {},
}

export function getWalletAdapter(): WalletAdapter {
  return adapter
}
