import {describe, expect, it} from 'vitest'

import {
  formatTokenAmount,
  parsePositiveTokenAmount,
  UINT256_MAX,
} from '../src/payments/amounts.ts'

describe('parsePositiveTokenAmount', () => {
  it('converts decimals to integer base units exactly', () => {
    expect(parsePositiveTokenAmount('1', 6)).toBe(1_000_000n)
    expect(parsePositiveTokenAmount('12.34', 6)).toBe(12_340_000n)
    expect(parsePositiveTokenAmount('0.000001', 6)).toBe(1n)
    expect(parsePositiveTokenAmount('0.1', 6)).toBe(100_000n)
  })

  it('is exact where floating point is not', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; base units must be exact.
    const sum =
      parsePositiveTokenAmount('0.1', 6) + parsePositiveTokenAmount('0.2', 6)
    expect(sum).toBe(parsePositiveTokenAmount('0.3', 6))
    expect(parsePositiveTokenAmount('9007199254740993', 0)).toBe(
      9007199254740993n,
    )
  })

  it.each([
    '',
    ' 1',
    '1 ',
    '-1',
    '+1',
    '1e6',
    '0x10',
    '1.',
    '.5',
    '01',
    '1,5',
    '0',
    '0.0',
    '0.0000001',
    'NaN',
    'Infinity',
  ])('rejects %j', input => {
    expect(() => parsePositiveTokenAmount(input, 6)).toThrow(RangeError)
  })

  it('rejects values above uint256', () => {
    expect(() =>
      parsePositiveTokenAmount((UINT256_MAX + 1n).toString(), 0),
    ).toThrow(/uint256/)
    expect(parsePositiveTokenAmount(UINT256_MAX.toString(), 0)).toBe(
      UINT256_MAX,
    )
  })
})

describe('formatTokenAmount', () => {
  it('round-trips', () => {
    for (const s of ['1', '12.34', '0.000001', '1000000']) {
      expect(formatTokenAmount(parsePositiveTokenAmount(s, 6), 6)).toBe(s)
    }
    expect(formatTokenAmount(0n, 6)).toBe('0')
    expect(formatTokenAmount(1_500_000n, 6)).toBe('1.5')
  })
})
