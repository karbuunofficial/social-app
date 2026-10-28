/** Largest value an ERC-20 `uint256` amount can hold. */
export const UINT256_MAX = 2n ** 256n - 1n

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/

/**
 * Parses a user-entered decimal string ("12.5") into integer base units
 * without ever using a JavaScript number. Rejects signs, exponents, whitespace,
 * more fractional digits than the token supports, zero, and values above
 * uint256.
 */
export function parsePositiveTokenAmount(
  input: string,
  decimals: number,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError('invalid token decimals')
  }
  if (!DECIMAL.test(input)) throw new RangeError('invalid amount format')
  const [whole = '', frac = ''] = input.split('.')
  if (frac.length > decimals) throw new RangeError('too many decimal places')
  const units = BigInt(whole + frac.padEnd(decimals, '0'))
  if (units <= 0n) throw new RangeError('amount must be greater than zero')
  if (units > UINT256_MAX) throw new RangeError('amount exceeds uint256')
  return units
}

/**
 * Formats integer base units as a decimal string, trimming trailing zeros.
 */
export function formatTokenAmount(units: bigint, decimals: number): string {
  if (units < 0n) throw new RangeError('negative amount')
  const s = units.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}
