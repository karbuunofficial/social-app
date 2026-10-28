import {type Wallet} from 'thirdweb/wallets'

import {THIRDWEB_CLIENT_ID} from '#/features/web3/config'
import {
  type WalletAdapter,
  WalletError,
  type WalletSnapshot,
} from '#/features/web3/wallet/types'

/**
 * EIP-1193 code for "user rejected the request".
 */
const USER_REJECTED_CODE = 4001

function isUserRejection(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const code = (e as {code?: unknown}).code
  return code === USER_REJECTED_CODE
}

/**
 * Loaded on demand so the thirdweb SDK lands in its own chunk and is only
 * downloaded when a user actually presses "Connect wallet".
 */
async function loadThirdweb() {
  const [core, wallets, chains, utils] = await Promise.all([
    import('thirdweb'),
    import('thirdweb/wallets'),
    import('thirdweb/chains'),
    import('thirdweb/utils'),
  ])
  disableThirdwebAnalytics(utils)
  return {core, wallets, chains}
}

/**
 * By default the SDK POSTs `{walletAddress, chainId, walletType}` to
 * `c.thirdweb.com` whenever a wallet connects, without asking the user. For a
 * social network that lets a third party correlate wallet addresses with this
 * site's users, so analytics are redirected to a name under the reserved
 * `.invalid` TLD (RFC 2606), which can never resolve. The SDK already ignores
 * failures of that call. Remove this only after a privacy review and a
 * matching privacy-policy update.
 */
const ANALYTICS_BLACKHOLE = 'thirdweb-analytics.invalid'
let analyticsDisabled = false

function disableThirdwebAnalytics(
  utils: typeof import('thirdweb/utils'),
): void {
  if (analyticsDisabled) return
  utils.setThirdwebDomains({analytics: ANALYTICS_BLACKHOLE})
  analyticsDisabled = true
}

function snapshotOf(wallet: Wallet): WalletSnapshot | null {
  const account = wallet.getAccount()
  const chain = wallet.getChain()
  if (!account || !chain) return null
  return {address: account.address, chainId: chain.id}
}

/*
 * thirdweb's `react-native` export condition makes the ios/android type passes
 * (which also compile `.web.ts` files) see a native typing of
 * `thirdweb/wallets` without the browser-only EIP-6963 discovery helper. At
 * runtime this file is only bundled for web, where the helper exists.
 */
type BrowserWallets = {getInstalledWallets: () => Wallet[]}

let current: Wallet | undefined

const adapter: WalletAdapter = {
  isSupported: true,

  async connect() {
    if (!THIRDWEB_CLIENT_ID) throw new WalletError('not_configured')
    try {
      const {core, wallets} = await loadThirdweb()
      const client = core.createThirdwebClient({clientId: THIRDWEB_CLIENT_ID})
      /*
       * Phase 1 uses the first wallet that announces itself via EIP-6963. A
       * wallet picker (and in-app / WalletConnect wallets) is Phase 2 work.
       */
      const [wallet] = (
        wallets as unknown as BrowserWallets
      ).getInstalledWallets()
      if (!wallet) throw new WalletError('no_wallet_detected')
      await wallet.connect({client})
      const snapshot = snapshotOf(wallet)
      if (!snapshot) throw new WalletError('unknown')
      current = wallet
      return snapshot
    } catch (e) {
      if (e instanceof WalletError) throw e
      throw new WalletError(isUserRejection(e) ? 'rejected' : 'unknown')
    }
  },

  async disconnect() {
    const wallet = current
    current = undefined
    await wallet?.disconnect()
  },

  async switchNetwork(chainId) {
    const {chains} = await loadThirdweb()
    const chain = [chains.base, chains.baseSepolia].find(c => c.id === chainId)
    if (!current || !chain) return
    await current.switchChain(chain)
  },

  subscribe(listener) {
    const wallet = current
    if (!wallet) return () => {}
    const emit = () => listener(snapshotOf(wallet))
    const offChain = wallet.subscribe('chainChanged', emit)
    const offAccounts = wallet.subscribe('accountChanged', emit)
    const offDisconnect = wallet.subscribe('disconnect', () => listener(null))
    return () => {
      offChain()
      offAccounts()
      offDisconnect()
    }
  },
}

export function getWalletAdapter(): WalletAdapter {
  return adapter
}
