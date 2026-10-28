import {describe, expect, it} from '@jest/globals'

import {
  formatUsdc,
  normalizeAmountInput,
  parseUsdcAmount,
} from '#/features/web3/tip/amount'

const bounds = {minUnits: 10_000n, maxUnits: 100_000_000n}
const ok = (s: string) => {
  const r = parseUsdcAmount(s, bounds)
  if (!r.ok) throw new Error(`expected ok: ${s} -> ${r.problem}`)
  return r.units
}
const problem = (s: string) => {
  const r = parseUsdcAmount(s, bounds)
  return r.ok ? 'ok' : r.problem
}

describe('parseUsdcAmount', () => {
  it('converts to exact integer base units', () => {
    expect(ok('1')).toBe(1_000_000n)
    expect(ok('1.5')).toBe(1_500_000n)
    expect(ok('0.01')).toBe(10_000n)
    expect(ok('100')).toBe(100_000_000n)
    expect(ok('12.345678')).toBe(12_345_678n)
  })

  it('has no floating point error', () => {
    expect(ok('0.1') + ok('0.2')).toBe(ok('0.3'))
    expect(ok('0.07')).toBe(70_000n)
    expect(ok('19.99')).toBe(19_990_000n)
  })

  it('accepts what people type', () => {
    expect(ok(' 2. ')).toBe(2_000_000n)
    expect(ok('.5')).toBe(500_000n)
    expect(normalizeAmountInput('.5')).toBe('0.5')
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['abc', 'format'],
    ['-1', 'format'],
    ['+1', 'format'],
    ['1e3', 'format'],
    ['1,5', 'format'],
    ['0x10', 'format'],
    ['01', 'format'],
    ['1.2.3', 'format'],
    ['1.0000001', 'too_many_decimals'],
    ['0', 'zero'],
    ['0.000000', 'zero'],
    ['0.009999', 'too_small'],
    ['100.000001', 'too_large'],
    ['99999999999999999999999999', 'too_large'],
  ])('rejects %j as %s', (input, expected) => {
    expect(problem(input)).toBe(expected)
  })

  it('returns the canonical text the API will receive', () => {
    const r = parseUsdcAmount(' .5 ', bounds)
    expect(r).toMatchObject({ok: true, text: '0.5'})
  })
})

describe('formatUsdc', () => {
  it('round-trips', () => {
    for (const s of ['1', '1.5', '0.01', '0.000001', '100']) {
      expect(formatUsdc(ok2(s))).toBe(s)
    }
    expect(formatUsdc(0n)).toBe('0')
  })
})

function ok2(s: string) {
  const r = parseUsdcAmount(s, {minUnits: 1n, maxUnits: 10n ** 12n})
  if (!r.ok) throw new Error(s)
  return r.units
}
