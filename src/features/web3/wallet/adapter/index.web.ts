import {type Wallet} from 'thirdweb/wallets'

import {THIRDWEB_CLIENT_ID} from '#/features/web3/config'
import {discoverWallets} from '#/features/web3/wallet/adapter/eip6963'
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
  const {code, message} = e as {code?: unknown; message?: unknown}
  return (
    code === USER_REJECTED_CODE ||
    (typeof message === 'string' &&
      /user (rejected|denied|cancel)/i.test(message))
  )
}

/**
 * Loaded on demand so the thirdweb SDK lands in its own chunks and is only
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

/*
 * thirdweb's `react-native` export condition makes the ios/android type passes
 * (which also compile `.web.ts` files) see a native typing of
 * `thirdweb/wallets` without the browser-only EIP-6963 discovery helper. At
 * runtime this file is only bundled for web, where the helper exists.
 */
type BrowserWallets = {getInstalledWallets: () => Wallet[]}

let current: Wallet | undefined
let currentName = ''

function snapshotOf(wallet: Wallet): WalletSnapshot | null {
  const account = wallet.getAccount()
  const chain = wallet.getChain()
  if (!account || !chain) return null
  return {address: account.address, chainId: chain.id, walletName: currentName}
}

function requireAccount() {
  const account = current?.getAccount()
  if (!current || !account) throw new WalletError('not_connected')
  return {wallet: current, account}
}

const adapter: WalletAdapter = {
  isSupported: true,

  async listWallets() {
    if (!THIRDWEB_CLIENT_ID) throw new WalletError('not_configured')
    return discoverWallets()
  },

  async connect(walletId) {
    if (!THIRDWEB_CLIENT_ID) throw new WalletError('not_configured')
    try {
      const options = await discoverWallets()
      const option = options.find(o => o.id === walletId)
      const {core, wallets} = await loadThirdweb()
      const client = core.createThirdwebClient({clientId: THIRDWEB_CLIENT_ID})
      const wallet = (wallets as unknown as BrowserWallets)
        .getInstalledWallets()
        .find(w => w.id === walletId)
      if (!wallet || !option) throw new WalletError('no_wallet_detected')
      currentName = option.name
      await wallet.connect({client})
      current = wallet
      const snapshot = snapshotOf(wallet)
      if (!snapshot) throw new WalletError('unknown')
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

  async signMessage(message) {
    const {account} = requireAccount()
    try {
      return await account.signMessage({message})
    } catch (e) {
      throw new WalletError(isUserRejection(e) ? 'rejected' : 'unknown')
    }
  },

  async sendTransaction(tx) {
    const {wallet, account} = requireAccount()
    // Never send on the wrong network, whatever the caller asked for.
    if (wallet.getChain()?.id !== tx.chainId)
      throw new WalletError('wrong_network')
    try {
      const sent = await account.sendTransaction({
        chainId: tx.chainId,
        to: tx.to,
        data: tx.data as `0x${string}`,
        value: 0n,
      })
      return sent.transactionHash
    } catch (e) {
      throw new WalletError(isUserRejection(e) ? 'rejected' : 'unknown')
    }
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
