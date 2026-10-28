import {describe, expect, it} from '@jest/globals'

import {createWalletStore} from '#/features/web3/wallet/store'
import {
  deriveWalletState,
  type WalletAdapter,
  WalletError,
  type WalletSnapshot,
} from '#/features/web3/wallet/types'

const EXPECTED = 84532
const ADDRESS = '0x1111111111111111111111111111111111111111'

function fakeAdapter(
  overrides: Partial<WalletAdapter> = {},
): WalletAdapter & {emit: (s: WalletSnapshot | null) => void} {
  let listener: ((s: WalletSnapshot | null) => void) | undefined
  return {
    isSupported: true,
    connect: () => Promise.resolve({address: ADDRESS, chainId: EXPECTED}),
    disconnect: () => Promise.resolve(),
    switchNetwork: () => Promise.resolve(),
    subscribe: l => {
      listener = l
      return () => {
        listener = undefined
      }
    },
    emit: s => listener?.(s),
    ...overrides,
  }
}

describe('wallet store', () => {
  it('starts disconnected on supported platforms', () => {
    const store = createWalletStore(fakeAdapter(), EXPECTED)
    expect(store.getState()).toEqual({status: 'disconnected'})
  })

  it('reports unsupported platforms without attempting a connection', async () => {
    let called = false
    const store = createWalletStore(
      fakeAdapter({
        isSupported: false,
        connect: () => {
          called = true
          return Promise.reject(new WalletError('unsupported_platform'))
        },
      }),
      EXPECTED,
    )
    expect(store.getState()).toEqual({
      status: 'failed',
      reason: 'unsupported_platform',
    })
    await store.connect()
    expect(called).toBe(false)
  })

  it('moves disconnected -> connecting -> connected', async () => {
    const store = createWalletStore(fakeAdapter(), EXPECTED)
    const seen: string[] = []
    store.subscribe(() => seen.push(store.getState().status))
    await store.connect()
    expect(seen).toEqual(['connecting', 'connected'])
    expect(store.getState()).toEqual({
      status: 'connected',
      address: ADDRESS,
      chainId: EXPECTED,
    })
  })

  it('reports wrong_network when the wallet is on another chain', async () => {
    const store = createWalletStore(
      fakeAdapter({
        connect: () => Promise.resolve({address: ADDRESS, chainId: 1}),
      }),
      EXPECTED,
    )
    await store.connect()
    expect(store.getState()).toEqual({
      status: 'wrong_network',
      address: ADDRESS,
      chainId: 1,
      expectedChainId: EXPECTED,
    })
  })

  it('follows chain changes after connecting', async () => {
    const adapter = fakeAdapter()
    const store = createWalletStore(adapter, EXPECTED)
    await store.connect()
    adapter.emit({address: ADDRESS, chainId: 8453})
    expect(store.getState().status).toBe('wrong_network')
    adapter.emit({address: ADDRESS, chainId: EXPECTED})
    expect(store.getState().status).toBe('connected')
  })

  it('returns to disconnected when the wallet disconnects itself', async () => {
    const adapter = fakeAdapter()
    const store = createWalletStore(adapter, EXPECTED)
    await store.connect()
    adapter.emit(null)
    expect(store.getState()).toEqual({status: 'disconnected'})
  })

  it('maps WalletError reasons to a failed state', async () => {
    const store = createWalletStore(
      fakeAdapter({
        connect: () => Promise.reject(new WalletError('rejected')),
      }),
      EXPECTED,
    )
    await store.connect()
    expect(store.getState()).toEqual({status: 'failed', reason: 'rejected'})
  })

  it('maps unexpected errors to an unknown failure without leaking them', async () => {
    const store = createWalletStore(
      fakeAdapter({
        connect: () => Promise.reject(new Error('rpc secret detail')),
      }),
      EXPECTED,
    )
    await store.connect()
    expect(store.getState()).toEqual({status: 'failed', reason: 'unknown'})
  })

  it('can retry after a failure', async () => {
    let attempts = 0
    const store = createWalletStore(
      fakeAdapter({
        connect: () => {
          attempts++
          return attempts === 1
            ? Promise.reject(new WalletError('no_wallet_detected'))
            : Promise.resolve({address: ADDRESS, chainId: EXPECTED})
        },
      }),
      EXPECTED,
    )
    await store.connect()
    expect(store.getState().status).toBe('failed')
    await store.connect()
    expect(store.getState().status).toBe('connected')
  })

  it('disconnects and ignores later wallet events', async () => {
    const adapter = fakeAdapter()
    const store = createWalletStore(adapter, EXPECTED)
    await store.connect()
    await store.disconnect()
    expect(store.getState()).toEqual({status: 'disconnected'})
    adapter.emit({address: ADDRESS, chainId: 1})
    expect(store.getState()).toEqual({status: 'disconnected'})
  })

  it('only requests a network switch from wrong_network', async () => {
    const requested: number[] = []
    const store = createWalletStore(
      fakeAdapter({
        switchNetwork: id => {
          requested.push(id)
          return Promise.resolve()
        },
      }),
      EXPECTED,
    )
    await store.switchNetwork()
    expect(requested).toEqual([])
  })
})

describe('helpers', () => {
  it('derives states from snapshots', () => {
    expect(deriveWalletState({address: ADDRESS, chainId: 1}, EXPECTED)).toEqual(
      {
        status: 'wrong_network',
        address: ADDRESS,
        chainId: 1,
        expectedChainId: EXPECTED,
      },
    )
  })
})
