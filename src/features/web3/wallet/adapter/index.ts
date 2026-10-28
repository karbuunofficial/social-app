import {
  type WalletAdapter,
  WalletError,
  type WalletSnapshot,
} from '#/features/web3/wallet/types'

/**
 * Native placeholder. Wallet support is web only: the thirdweb React Native
 * path needs extra native modules and has not been validated against this app's
 * React Native and Expo versions. Because this file never imports thirdweb, the
 * native bundles are unaffected by the SDK.
 */
const unsupported = <T>(): Promise<T> =>
  Promise.reject(new WalletError('unsupported_platform'))

const adapter: WalletAdapter = {
  isSupported: false,
  listWallets: () => Promise.resolve([]),
  connect: (): Promise<WalletSnapshot> => unsupported(),
  disconnect: () => Promise.resolve(),
  switchNetwork: () => Promise.resolve(),
  signMessage: () => unsupported(),
  sendTransaction: () => unsupported(),
  subscribe: () => () => {},
}

export function getWalletAdapter(): WalletAdapter {
  return adapter
}
