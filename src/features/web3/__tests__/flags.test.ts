import {describe, expect, it} from '@jest/globals'

import {resolveTargetNetwork} from '#/features/web3/config'
import {resolveWeb3Flags} from '#/features/web3/flags'

describe('resolveWeb3Flags', () => {
  it('defaults every flag to disabled', () => {
    expect(resolveWeb3Flags({})).toEqual({
      web3Enabled: false,
      walletConnectEnabled: false,
      tippingEnabled: false,
      subscriptionsEnabled: false,
    })
  })

  it('treats empty and unrecognised values as disabled', () => {
    const flags = resolveWeb3Flags({
      web3: '',
      walletConnect: 'yes',
      tipping: 'enabled',
      subscriptions: 'false',
    })
    expect(Object.values(flags).every(v => v === false)).toBe(true)
  })

  it('ignores sub-flags while the master switch is off', () => {
    const flags = resolveWeb3Flags({
      walletConnect: 'true',
      tipping: 'true',
      subscriptions: 'true',
    })
    expect(flags).toEqual({
      web3Enabled: false,
      walletConnectEnabled: false,
      tippingEnabled: false,
      subscriptionsEnabled: false,
    })
  })

  it('enables sub-flags independently once the master switch is on', () => {
    expect(resolveWeb3Flags({web3: 'true'})).toEqual({
      web3Enabled: true,
      walletConnectEnabled: false,
      tippingEnabled: false,
      subscriptionsEnabled: false,
    })
    expect(
      resolveWeb3Flags({web3: '1', walletConnect: ' TRUE ', tipping: '1'}),
    ).toEqual({
      web3Enabled: true,
      walletConnectEnabled: true,
      tippingEnabled: true,
      subscriptionsEnabled: false,
    })
  })
})

describe('resolveTargetNetwork', () => {
  it('only resolves to Base mainnet for the exact value "base"', () => {
    expect(resolveTargetNetwork('base').chainId).toBe(8453)
    expect(resolveTargetNetwork(' Base ').chainId).toBe(8453)
  })

  it('fails safe to Base Sepolia for missing or mistyped values', () => {
    for (const v of [undefined, '', 'mainnet', 'base-mainnet', '8453']) {
      expect(resolveTargetNetwork(v)).toMatchObject({
        chainId: 84532,
        isTestnet: true,
      })
    }
  })
})
