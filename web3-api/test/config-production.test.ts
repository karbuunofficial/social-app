import {describe, expect, it} from 'vitest'

import {ConfigError, loadConfig} from '../src/config.ts'
import {isValidNsidPrefix} from '../src/lexicon-ids.ts'
import {baseEnv} from './helpers/fixtures.ts'

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

/** A configuration that satisfies every production rule. */
const prod = {
  ...baseEnv,
  NODE_ENV: 'production',
  WEB_APP_ORIGIN: 'https://app.example.org',
  CORS_ALLOWED_ORIGINS: 'https://app.example.org',
  DATABASE_SSL: 'true',
  SERVICE_DID: 'did:web:api.example.org',
  SERVICE_PUBLIC_URL: 'https://api.example.org',
  NSID_PREFIX: 'org.example.web3',
  LOG_LEVEL: 'info',
}

const issues = (env: Record<string, string>) => {
  try {
    loadConfig(env)
    return ''
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError)
    return (e as ConfigError).message
  }
}

describe('production gate', () => {
  it('accepts a fully hardened configuration', () => {
    expect(issues(prod)).toBe('')
  })

  it.each([
    ['placeholder NSID prefix', {NSID_PREFIX: 'app.web3'}, 'NSID_PREFIX'],
    [
      'http web origin',
      {WEB_APP_ORIGIN: 'http://app.example.org'},
      'WEB_APP_ORIGIN',
    ],
    ['empty CORS list', {CORS_ALLOWED_ORIGINS: ''}, 'CORS_ALLOWED_ORIGINS'],
    ['wildcard CORS', {CORS_ALLOWED_ORIGINS: '*'}, 'CORS_ALLOWED_ORIGINS'],
    [
      'http CORS origin',
      {CORS_ALLOWED_ORIGINS: 'http://app.example.org'},
      'CORS_ALLOWED_ORIGINS',
    ],
    ['no database TLS', {DATABASE_SSL: 'false'}, 'DATABASE_SSL'],
    [
      'localhost service DID',
      {SERVICE_DID: 'did:web:localhost%3A8787'},
      'SERVICE_DID',
    ],
    [
      'http public URL',
      {SERVICE_PUBLIC_URL: 'http://api.example.org'},
      'SERVICE_PUBLIC_URL',
    ],
    ['debug logging', {LOG_LEVEL: 'debug'}, 'LOG_LEVEL'],
    ['dev-insecure auth', {AUTH_MODE: 'dev-insecure'}, 'AUTH_MODE'],
    [
      'insecure PLC',
      {ALLOW_INSECURE_PLC: 'true', PLC_URL: 'http://plc.example.org'},
      'ALLOW_INSECURE_PLC',
    ],
    ['http RPC', {RPC_URL_84532: 'http://rpc.example.org'}, 'RPC_URL_84532'],
  ])('refuses %s', (_name, override, key) => {
    expect(issues({...prod, ...override})).toContain(key)
  })

  it('applies none of those rules outside production', () => {
    expect(
      issues({
        ...baseEnv,
        NSID_PREFIX: 'app.web3',
        CORS_ALLOWED_ORIGINS: 'http://localhost:19006',
        DATABASE_SSL: 'false',
      }),
    ).toBe('')
  })
})

describe('tipping safety (every environment)', () => {
  const tipping = {
    ...baseEnv,
    TIPPING_CHAIN_IDS: '84532',
    RPC_URL_84532: 'https://sepolia.base.org',
    USDC_ADDRESS_84532: USDC,
  }

  it('accepts Base Sepolia with the issuer-published USDC address', () => {
    const c = loadConfig(tipping)
    expect(c.TIPPING_CHAIN_IDS).toEqual([84532])
    expect(c.TIP_MIN_UNITS).toBe(10000n)
    expect(typeof c.TIP_MAX_UNITS).toBe('bigint')
  })

  it('is disabled by default', () => {
    expect(loadConfig(baseEnv).TIPPING_CHAIN_IDS).toEqual([])
  })

  it('refuses Base mainnet tipping in every environment', () => {
    expect(
      issues({
        ...tipping,
        ALLOWED_CHAIN_IDS: '84532,8453',
        TIPPING_CHAIN_IDS: '8453',
        RPC_URL_8453: 'https://mainnet.base.org',
        USDC_ADDRESS_8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      }),
    ).toContain('Base mainnet tipping is disabled')
  })

  it('refuses a USDC address that is not the issuer-published one', () => {
    expect(
      issues({
        ...tipping,
        USDC_ADDRESS_84532: '0x1111111111111111111111111111111111111111',
      }),
    ).toContain('issuer-published')
    // Only an explicit dev override allows it, never in production.
    expect(
      loadConfig({
        ...tipping,
        USDC_ADDRESS_84532: '0x1111111111111111111111111111111111111111',
        ALLOW_CUSTOM_TOKEN_ADDRESS: 'true',
      }).USDC_ADDRESSES[84532],
    ).toBe('0x1111111111111111111111111111111111111111')
    expect(
      issues({
        ...prod,
        ...tipping,
        USDC_ADDRESS_84532: '0x1111111111111111111111111111111111111111',
        ALLOW_CUSTOM_TOKEN_ADDRESS: 'true',
      }),
    ).toContain('ALLOW_CUSTOM_TOKEN_ADDRESS')
  })

  it('requires RPC, address and an allowed chain when tipping is on', () => {
    expect(issues({...baseEnv, TIPPING_CHAIN_IDS: '84532'})).toMatch(
      /RPC_URL_84532[\s\S]*USDC_ADDRESS_84532/,
    )
    expect(issues({...tipping, ALLOWED_CHAIN_IDS: '8453'})).toContain(
      'ALLOWED_CHAIN_IDS',
    )
  })

  it('validates bounds', () => {
    expect(issues({...tipping, TIP_MIN_UNITS: '0'})).toContain('TIP_MIN_UNITS')
    expect(
      issues({...tipping, TIP_MIN_UNITS: '5', TIP_MAX_UNITS: '4'}),
    ).toContain('TIP_MIN_UNITS')
    expect(issues({...tipping, TIP_MAX_UNITS: '1.5'})).toContain(
      'TIP_MAX_UNITS',
    )
  })

  it('requires an RPC for each chain when smart-wallet verification is on', () => {
    expect(issues({...baseEnv, SMART_WALLET_SIGNATURES: 'true'})).toContain(
      'RPC_URL_84532',
    )
  })
})

describe('NSID prefix', () => {
  it.each(['app.web3', 'org.example.web3', 'social.example.api'])(
    'accepts %s',
    p => {
      expect(isValidNsidPrefix(p)).toBe(true)
    },
  )
  it.each([
    'app.bsky',
    'app.bsky.feed',
    'chat.bsky',
    'com.atproto',
    'Single',
    'a',
    'has space.x',
    'x..y',
    '-a.b',
    '',
  ])('rejects %j', p => {
    expect(isValidNsidPrefix(p)).toBe(false)
  })
})
