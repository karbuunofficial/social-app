import {describe, expect, it} from '@jest/globals'

import {createWalletStore} from '#/features/web3/wallet/store'
import {
  deriveWalletState,
  safeWalletIcon,
  type WalletAdapter,
  WalletError,
  type WalletOption,
  type WalletSnapshot,
} from '#/features/web3/wallet/types'

const EXPECTED = 84532
const ADDRESS = '0x1111111111111111111111111111111111111111'
const HASH = `0x${'ab'.repeat(32)}` as const
const METAMASK: WalletOption = {id: 'io.metamask', name: 'MetaMask'}
const RABBY: WalletOption = {id: 'io.rabby', name: 'Rabby'}

type Fake = WalletAdapter & {
  emit: (s: WalletSnapshot | null) => void
  sent: unknown[]
  signed: string[]
  connectedWith: string[]
}

function fakeAdapter(
  overrides: Partial<WalletAdapter> = {},
  wallets: WalletOption[] = [METAMASK],
): Fake {
  let listener: ((s: WalletSnapshot | null) => void) | undefined
  const fake: Fake = {
    isSupported: true,
    listWallets: () => Promise.resolve(wallets),
    connect: id => {
      fake.connectedWith.push(id)
      return Promise.resolve({
        address: ADDRESS,
        chainId: EXPECTED,
        walletName: 'MetaMask',
      })
    },
    disconnect: () => Promise.resolve(),
    switchNetwork: () => Promise.resolve(),
    signMessage: m => {
      fake.signed.push(m)
      return Promise.resolve(HASH)
    },
    sendTransaction: tx => {
      fake.sent.push(tx)
      return Promise.resolve(HASH)
    },
    subscribe: l => {
      listener = l
      return () => {
        listener = undefined
      }
    },
    emit: s => listener?.(s),
    sent: [],
    signed: [],
    connectedWith: [],
    ...overrides,
  }
  return fake
}

const tx = {chainId: EXPECTED, to: ADDRESS, data: '0x', value: '0'} as const

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
        listWallets: () => {
          called = true
          return Promise.resolve([])
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

  describe('connecting', () => {
    it('connects straight away when exactly one wallet is installed', async () => {
      const adapter = fakeAdapter()
      const store = createWalletStore(adapter, EXPECTED)
      const seen: string[] = []
      store.subscribe(() => seen.push(store.getState().status))
      await store.connect()
      expect(seen).toEqual(['connecting', 'connecting', 'connected'])
      expect(adapter.connectedWith).toEqual(['io.metamask'])
      expect(store.getState()).toEqual({
        status: 'connected',
        address: ADDRESS,
        chainId: EXPECTED,
        walletName: 'MetaMask',
      })
    })

    it('asks the user to choose when several wallets are installed, and connects nothing yet', async () => {
      const adapter = fakeAdapter({}, [METAMASK, RABBY])
      const store = createWalletStore(adapter, EXPECTED)
      await store.connect()
      expect(store.getState()).toEqual({
        status: 'choosing',
        options: [METAMASK, RABBY],
      })
      expect(adapter.connectedWith).toEqual([])
    })

    it('connects the chosen wallet, and only that one', async () => {
      const adapter = fakeAdapter({}, [METAMASK, RABBY])
      const store = createWalletStore(adapter, EXPECTED)
      await store.connect()
      await store.connect('io.rabby')
      expect(adapter.connectedWith).toEqual(['io.rabby'])
      expect(store.getState().status).toBe('connected')
    })

    it('can back out of the chooser', async () => {
      const store = createWalletStore(
        fakeAdapter({}, [METAMASK, RABBY]),
        EXPECTED,
      )
      await store.connect()
      store.cancelChoosing()
      expect(store.getState()).toEqual({status: 'disconnected'})
      // A no-op from any other state.
      store.cancelChoosing()
      expect(store.getState()).toEqual({status: 'disconnected'})
    })

    it('fails with no_wallet_detected when nothing is installed', async () => {
      const store = createWalletStore(fakeAdapter({}, []), EXPECTED)
      await store.connect()
      expect(store.getState()).toEqual({
        status: 'failed',
        reason: 'no_wallet_detected',
      })
    })

    it('reports a configuration problem from discovery', async () => {
      const store = createWalletStore(
        fakeAdapter({
          listWallets: () => Promise.reject(new WalletError('not_configured')),
        }),
        EXPECTED,
      )
      await store.connect()
      expect(store.getState()).toEqual({
        status: 'failed',
        reason: 'not_configured',
      })
    })

    it('maps wallet rejection and unexpected errors to failed states without leaking details', async () => {
      const rejected = createWalletStore(
        fakeAdapter({
          connect: () => Promise.reject(new WalletError('rejected')),
        }),
        EXPECTED,
      )
      await rejected.connect()
      expect(rejected.getState()).toEqual({
        status: 'failed',
        reason: 'rejected',
      })

      const odd = createWalletStore(
        fakeAdapter({
          connect: () => Promise.reject(new Error('rpc secret detail')),
        }),
        EXPECTED,
      )
      await odd.connect()
      expect(odd.getState()).toEqual({status: 'failed', reason: 'unknown'})
    })

    it('can retry after a failure', async () => {
      let attempts = 0
      const store = createWalletStore(
        fakeAdapter({
          connect: () => {
            attempts++
            return attempts === 1
              ? Promise.reject(new WalletError('rejected'))
              : Promise.resolve({
                  address: ADDRESS,
                  chainId: EXPECTED,
                  walletName: 'MetaMask',
                })
          },
        }),
        EXPECTED,
      )
      await store.connect()
      expect(store.getState().status).toBe('failed')
      await store.connect()
      expect(store.getState().status).toBe('connected')
    })
  })

  describe('network and lifecycle', () => {
    it('reports wrong_network when the wallet is on another chain', async () => {
      const store = createWalletStore(
        fakeAdapter({
          connect: () =>
            Promise.resolve({
              address: ADDRESS,
              chainId: 1,
              walletName: 'MetaMask',
            }),
        }),
        EXPECTED,
      )
      await store.connect()
      expect(store.getState()).toEqual({
        status: 'wrong_network',
        address: ADDRESS,
        chainId: 1,
        expectedChainId: EXPECTED,
        walletName: 'MetaMask',
      })
    })

    it('follows chain and account changes after connecting', async () => {
      const adapter = fakeAdapter()
      const store = createWalletStore(adapter, EXPECTED)
      await store.connect()
      adapter.emit({address: ADDRESS, chainId: 8453, walletName: 'MetaMask'})
      expect(store.getState().status).toBe('wrong_network')
      adapter.emit({
        address: ADDRESS,
        chainId: EXPECTED,
        walletName: 'MetaMask',
      })
      expect(store.getState().status).toBe('connected')
      const other = '0x2222222222222222222222222222222222222222'
      adapter.emit({address: other, chainId: EXPECTED, walletName: 'MetaMask'})
      expect(store.getState()).toMatchObject({
        status: 'connected',
        address: other,
      })
    })

    it('returns to disconnected when the wallet disconnects itself, and after Disconnect', async () => {
      const adapter = fakeAdapter()
      const store = createWalletStore(adapter, EXPECTED)
      await store.connect()
      adapter.emit(null)
      expect(store.getState()).toEqual({status: 'disconnected'})

      await store.connect()
      await store.disconnect()
      expect(store.getState()).toEqual({status: 'disconnected'})
      adapter.emit({address: ADDRESS, chainId: 1, walletName: 'MetaMask'})
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

  describe('signing and sending', () => {
    it('refuses to sign or send when no wallet is connected', async () => {
      const adapter = fakeAdapter()
      const store = createWalletStore(adapter, EXPECTED)
      await expect(store.signMessage('hi')).rejects.toMatchObject({
        reason: 'not_connected',
      })
      await expect(store.sendTransaction(tx)).rejects.toMatchObject({
        reason: 'not_connected',
      })
      expect(adapter.signed).toEqual([])
      expect(adapter.sent).toEqual([])
    })

    it('signs messages when connected', async () => {
      const adapter = fakeAdapter()
      const store = createWalletStore(adapter, EXPECTED)
      await store.connect()
      await expect(store.signMessage('hello')).resolves.toBe(HASH)
      expect(adapter.signed).toEqual(['hello'])
    })

    it('sends a transaction only from a connected wallet on the expected network', async () => {
      const adapter = fakeAdapter()
      const store = createWalletStore(adapter, EXPECTED)
      await store.connect()
      await expect(store.sendTransaction(tx)).resolves.toBe(HASH)
      expect(adapter.sent).toHaveLength(1)

      // Wrong network: refused before the adapter is even asked.
      adapter.emit({address: ADDRESS, chainId: 1, walletName: 'MetaMask'})
      await expect(store.sendTransaction(tx)).rejects.toMatchObject({
        reason: 'wrong_network',
      })
      expect(adapter.sent).toHaveLength(1)
    })

    it('passes wallet rejections through', async () => {
      const store = createWalletStore(
        fakeAdapter({
          sendTransaction: () => Promise.reject(new WalletError('rejected')),
        }),
        EXPECTED,
      )
      await store.connect()
      await expect(store.sendTransaction(tx)).rejects.toMatchObject({
        reason: 'rejected',
      })
    })
  })
})

describe('helpers', () => {
  it('derives states from snapshots', () => {
    expect(
      deriveWalletState(
        {address: ADDRESS, chainId: 1, walletName: 'W'},
        EXPECTED,
      ),
    ).toMatchObject({status: 'wrong_network', expectedChainId: EXPECTED})
  })

  it('only accepts safe icon data URIs from wallets', () => {
    expect(safeWalletIcon('data:image/svg+xml;base64,AAAA')).toBeDefined()
    expect(safeWalletIcon('data:image/png;base64,AAAA')).toBeDefined()
    expect(safeWalletIcon('https://tracker.example/pixel.png')).toBeUndefined()
    expect(safeWalletIcon('javascript:alert(1)')).toBeUndefined()
    expect(safeWalletIcon('data:text/html;base64,AAAA')).toBeUndefined()
    expect(safeWalletIcon(42)).toBeUndefined()
    expect(
      safeWalletIcon(`data:image/png;base64,${'A'.repeat(200_000)}`),
    ).toBeUndefined()
  })
})
