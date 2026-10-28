import {isAddress} from 'viem'
import {z} from 'zod'

const csv = z
  .string()
  .default('')
  .transform(v =>
    v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  )

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform(v => v === 'true' || v === '1')

const didSchema = z.string().regex(/^did:(web|plc):[a-zA-Z0-9._:%-]+$/)

/**
 * Optional token address. An empty string means "not configured". A value must
 * be a valid, correctly checksummed EVM address; there is deliberately no
 * default, because the operator must take it from the issuer's documentation.
 */
const optionalAddress = z
  .string()
  .default('')
  .refine(v => v === '' || isAddress(v, {strict: true}), {
    message: 'must be a valid EVM address (checksummed if mixed case)',
  })

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_SSL: bool,

    WEB_APP_ORIGIN: z.url(),
    CORS_ALLOWED_ORIGINS: csv,

    SERVICE_DID: didSchema,
    AUTH_MODE: z.enum(['atproto', 'dev-insecure']).default('atproto'),
    PLC_URL: z.url().default('https://plc.directory'),
    /** Development only: allow a plain-http PLC directory (local AT Protocol). */
    ALLOW_INSECURE_PLC: bool,

    WALLET_CHALLENGE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(900)
      .default(300),
    ALLOWED_CHAIN_IDS: csv.transform((ids, ctx) => {
      const nums = ids.map(Number)
      if (nums.length === 0 || nums.some(n => !Number.isInteger(n) || n <= 0)) {
        ctx.addIssue({
          code: 'custom',
          message: 'must be a comma-separated list of positive integers',
        })
        return z.NEVER
      }
      return nums
    }),
    USDC_ADDRESS_84532: optionalAddress,
    USDC_ADDRESS_8453: optionalAddress,
  })
  .superRefine((env, ctx) => {
    if (!env.ALLOW_INSECURE_PLC && !env.PLC_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PLC_URL'],
        message:
          'must be an https URL (set ALLOW_INSECURE_PLC=true for local dev)',
      })
    }
    if (env.NODE_ENV === 'production' && env.ALLOW_INSECURE_PLC) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOW_INSECURE_PLC'],
        message: 'is not allowed when NODE_ENV=production',
      })
    }
    if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'dev-insecure') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'dev-insecure auth is not allowed when NODE_ENV=production',
      })
    }
  })

export type Config = Omit<
  z.infer<typeof envSchema>,
  'USDC_ADDRESS_84532' | 'USDC_ADDRESS_8453'
> & {
  /** Domain bound into every SIWE message (host of WEB_APP_ORIGIN). */
  SIWE_DOMAIN: string
  /** Configured USDC address per chain id. Missing key means "not configured". */
  USDC_ADDRESSES: Record<number, string>
}

export class ConfigError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

/**
 * Validates the environment once at startup. Only variable names and the
 * reason are reported, never values, so secrets in a bad config are not logged.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
    )
  }
  const {USDC_ADDRESS_84532, USDC_ADDRESS_8453, ...rest} = parsed.data
  const USDC_ADDRESSES: Record<number, string> = {}
  if (USDC_ADDRESS_84532) USDC_ADDRESSES[84532] = USDC_ADDRESS_84532
  if (USDC_ADDRESS_8453) USDC_ADDRESSES[8453] = USDC_ADDRESS_8453
  return {
    ...rest,
    SIWE_DOMAIN: new URL(rest.WEB_APP_ORIGIN).host,
    USDC_ADDRESSES,
  }
}
