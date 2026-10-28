import {describe, expect, it} from 'vitest'

import {ConfigError, loadConfig} from '../src/config.ts'
import {baseEnv} from './helpers/fixtures.ts'

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const c = loadConfig(baseEnv)
    expect(c).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 8787,
      AUTH_MODE: 'atproto',
      WALLET_CHALLENGE_TTL_SECONDS: 300,
      ALLOWED_CHAIN_IDS: [84532],
      SIWE_DOMAIN: 'localhost:19006',
      USDC_ADDRESSES: {},
    })
  })

  it('has no default USDC address', () => {
    expect(loadConfig(baseEnv).USDC_ADDRESSES).toEqual({})
  })

  it('reports every problem and never echoes values', () => {
    try {
      loadConfig({DATABASE_URL: 'mysql://user:hunter2@host/db'})
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      const msg = (e as ConfigError).message
      expect(msg).toContain('DATABASE_URL')
      expect(msg).toContain('WEB_APP_ORIGIN')
      expect(msg).toContain('SERVICE_DID')
      expect(msg).not.toContain('hunter2')
    }
  })

  it('refuses dev-insecure auth in production', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        AUTH_MODE: 'dev-insecure',
      }),
    ).toThrow(/dev-insecure/)
    expect(
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'development',
        AUTH_MODE: 'dev-insecure',
      }).AUTH_MODE,
    ).toBe('dev-insecure')
  })

  it('requires an https PLC unless explicitly allowed for local dev', () => {
    const http = {...baseEnv, PLC_URL: 'http://localhost:3001'}
    expect(() => loadConfig(http)).toThrow(/PLC_URL/)
    expect(loadConfig({...http, ALLOW_INSECURE_PLC: 'true'}).PLC_URL).toBe(
      'http://localhost:3001',
    )
    expect(() =>
      loadConfig({...http, ALLOW_INSECURE_PLC: 'true', NODE_ENV: 'production'}),
    ).toThrow(/ALLOW_INSECURE_PLC/)
  })

  it('validates chain ids and token addresses', () => {
    expect(() =>
      loadConfig({...baseEnv, ALLOWED_CHAIN_IDS: '84532,abc'}),
    ).toThrow(/ALLOWED_CHAIN_IDS/)
    expect(() => loadConfig({...baseEnv, ALLOWED_CHAIN_IDS: ''})).toThrow(
      /ALLOWED_CHAIN_IDS/,
    )
    expect(() => loadConfig({...baseEnv, USDC_ADDRESS_84532: '0x123'})).toThrow(
      /USDC_ADDRESS_84532/,
    )
    // Mixed case with a wrong checksum is rejected.
    expect(() =>
      loadConfig({
        ...baseEnv,
        USDC_ADDRESS_84532: '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa',
      }),
    ).toThrow(/USDC_ADDRESS_84532/)
    // All lowercase is accepted (no checksum claimed).
    expect(
      loadConfig({
        ...baseEnv,
        USDC_ADDRESS_84532: '0x1111111111111111111111111111111111111111',
      }).USDC_ADDRESSES,
    ).toEqual({84532: '0x1111111111111111111111111111111111111111'})
  })
})
