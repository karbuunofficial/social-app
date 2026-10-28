import {useSyncExternalStore} from 'react'

import {TARGET_NETWORK} from '#/features/web3/config'
import {getWalletAdapter} from '#/features/web3/wallet/adapter'
import {
  deriveWalletState,
  type WalletAdapter,
  WalletError,
  type WalletState,
  type WalletTransaction,
} from '#/features/web3/wallet/types'

export type WalletStore = {
  getState(): WalletState
  subscribe(listener: () => void): () => void
  /**
   * With no id: connects directly when exactly one wallet is installed, and
   * asks the user to choose when there are several.
   */
  connect(walletId?: string): Promise<void>
  /** Leaves the wallet chooser without connecting. */
  cancelChoosing(): void
  disconnect(): Promise<void>
  switchNetwork(): Promise<void>
  signMessage(message: string): Promise<`0x${string}`>
  sendTransaction(tx: WalletTransaction): Promise<`0x${string}`>
}

/**
 * A tiny external store instead of a context provider, so enabling Web3 adds
 * nothing to the app's provider tree. Wallet state is in memory only and is
 * deliberately independent of the AT Protocol session.
 */
export function createWalletStore(
  adapter: WalletAdapter,
  expectedChainId: number,
): WalletStore {
  let state: WalletState = adapter.isSupported
    ? {status: 'disconnected'}
    : {status: 'failed', reason: 'unsupported_platform'}
  const listeners = new Set<() => void>()
  let unsubscribeAdapter: (() => void) | undefined

  function set(next: WalletState) {
    state = next
    listeners.forEach(l => l())
  }

  function watch() {
    unsubscribeAdapter?.()
    unsubscribeAdapter = adapter.subscribe(snapshot => {
      if (!snapshot) {
        unsubscribeAdapter?.()
        unsubscribeAdapter = undefined
        set({status: 'disconnected'})
        return
      }
      set(deriveWalletState(snapshot, expectedChainId))
    })
  }

  const fail = (e: unknown) =>
    set({
      status: 'failed',
      reason: e instanceof WalletError ? e.reason : 'unknown',
    })

  async function connectTo(walletId: string) {
    set({status: 'connecting'})
    try {
      const snapshot = await adapter.connect(walletId)
      watch()
      set(deriveWalletState(snapshot, expectedChainId))
    } catch (e) {
      fail(e)
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async connect(walletId) {
      if (!adapter.isSupported || state.status === 'connecting') return
      if (walletId) return connectTo(walletId)

      set({status: 'connecting'})
      let options
      try {
        options = await adapter.listWallets()
      } catch (e) {
        return fail(e)
      }
      if (options.length === 0) {
        return fail(new WalletError('no_wallet_detected'))
      }
      if (options.length === 1) return connectTo(options[0].id)
      set({status: 'choosing', options})
    },

    cancelChoosing() {
      if (state.status === 'choosing') set({status: 'disconnected'})
    },

    async disconnect() {
      unsubscribeAdapter?.()
      unsubscribeAdapter = undefined
      try {
        await adapter.disconnect()
      } finally {
        set({status: 'disconnected'})
      }
    },

    async switchNetwork() {
      if (state.status !== 'wrong_network') return
      try {
        await adapter.switchNetwork(expectedChainId)
      } catch {
        // The wallet reports success through `subscribe`; if the user declines
        // the switch we simply stay in `wrong_network`.
      }
    },

    signMessage(message) {
      if (state.status !== 'connected' && state.status !== 'wrong_network') {
        return Promise.reject(new WalletError('not_connected'))
      }
      return adapter.signMessage(message)
    },

    sendTransaction(tx) {
      // Payments only ever leave from a wallet that is connected AND on the
      // expected network.
      if (state.status === 'wrong_network') {
        return Promise.reject(new WalletError('wrong_network'))
      }
      if (state.status !== 'connected') {
        return Promise.reject(new WalletError('not_connected'))
      }
      return adapter.sendTransaction(tx)
    },
  }
}

let defaultStore: WalletStore | undefined

function getDefaultStore(): WalletStore {
  defaultStore ??= createWalletStore(getWalletAdapter(), TARGET_NETWORK.chainId)
  return defaultStore
}

export function useWallet(): WalletState &
  Omit<WalletStore, 'getState' | 'subscribe'> {
  const store = getDefaultStore()
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  )
  return {
    ...state,
    connect: store.connect,
    cancelChoosing: store.cancelChoosing,
    disconnect: store.disconnect,
    switchNetwork: store.switchNetwork,
    signMessage: store.signMessage,
    sendTransaction: store.sendTransaction,
  }
}
