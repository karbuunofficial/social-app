import {useSyncExternalStore} from 'react'

import {TARGET_NETWORK} from '#/features/web3/config'
import {getWalletAdapter} from '#/features/web3/wallet/adapter'
import {
  deriveWalletState,
  type WalletAdapter,
  WalletError,
  type WalletState,
} from '#/features/web3/wallet/types'

export type WalletStore = {
  getState(): WalletState
  subscribe(listener: () => void): () => void
  connect(): Promise<void>
  disconnect(): Promise<void>
  switchNetwork(): Promise<void>
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

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async connect() {
      if (!adapter.isSupported || state.status === 'connecting') return
      set({status: 'connecting'})
      try {
        const snapshot = await adapter.connect()
        watch()
        set(deriveWalletState(snapshot, expectedChainId))
      } catch (e) {
        set({
          status: 'failed',
          reason: e instanceof WalletError ? e.reason : 'unknown',
        })
      }
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
  }
}

let defaultStore: WalletStore | undefined

function getDefaultStore(): WalletStore {
  defaultStore ??= createWalletStore(getWalletAdapter(), TARGET_NETWORK.chainId)
  return defaultStore
}

export function useWallet(): WalletState & {
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  switchNetwork: () => Promise<void>
} {
  const store = getDefaultStore()
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  )
  return {
    ...state,
    connect: store.connect,
    disconnect: store.disconnect,
    switchNetwork: store.switchNetwork,
  }
}
