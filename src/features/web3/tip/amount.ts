/** USDC has 6 decimals. */
export const USDC_DECIMALS = 6

export type AmountProblem =
  'empty' | 'format' | 'too_many_decimals' | 'zero' | 'too_small' | 'too_large'

export type ParsedAmount =
  | {
      ok: true
      units: bigint
      /** Canonical decimal text, e.g. "1.5". */ text: string
    }
  | {ok: false; problem: AmountProblem}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/

/**
 * Tidies what a person types ("  .5", "2.") into the strict form the API
 * accepts. Anything stranger (signs, exponents, commas) is left alone and
 * rejected by {@link parseUsdcAmount}.
 */
export function normalizeAmountInput(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('.')) s = `0${s}`
  if (s.endsWith('.')) s = s.slice(0, -1)
  return s
}

/**
 * Parses a USDC amount into integer base units. No floating point is involved
 * at any step, so there is no rounding: 0.1 + 0.2 is exactly 0.3. The rules
 * match the server's, which re-validates everything.
 */
export function parseUsdcAmount(
  raw: string,
  bounds: {minUnits: bigint; maxUnits: bigint},
): ParsedAmount {
  const text = normalizeAmountInput(raw)
  if (text === '') return {ok: false, problem: 'empty'}
  if (!DECIMAL.test(text)) return {ok: false, problem: 'format'}
  const [whole = '', frac = ''] = text.split('.')
  if (frac.length > USDC_DECIMALS) {
    return {ok: false, problem: 'too_many_decimals'}
  }
  const units = BigInt(whole + frac.padEnd(USDC_DECIMALS, '0'))
  if (units === 0n) return {ok: false, problem: 'zero'}
  if (units < bounds.minUnits) return {ok: false, problem: 'too_small'}
  if (units > bounds.maxUnits) return {ok: false, problem: 'too_large'}
  return {ok: true, units, text}
}

/** Integer base units to a human-readable decimal string. */
export function formatUsdc(units: bigint): string {
  const s = units.toString().padStart(USDC_DECIMALS + 1, '0')
  const whole = s.slice(0, s.length - USDC_DECIMALS)
  const frac = s.slice(s.length - USDC_DECIMALS).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}
