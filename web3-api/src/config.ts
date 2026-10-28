import {isAddress} from 'viem'
import {z} from 'zod'

import {isValidNsidPrefix, PLACEHOLDER_NSID_PREFIX} from './lexicon-ids.ts'
import {ISSUER_PUBLISHED_USDC} from './payments/issuer-addresses.ts'

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

const digits = z
  .string()
  .regex(/^[0-9]{1,40}$/, 'must be a non-negative integer')

const optionalHttpsUrl = z
  .string()
  .default('')
  .refine(v => v === '' || URL.canParse(v), {message: 'must be a URL'})

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
    /** Public base URL of this service, published in its DID document. */
    SERVICE_PUBLIC_URL: z.url().optional(),
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
    /** Public JSON-RPC endpoints used to read chains (never to sign). */
    RPC_URL_84532: optionalHttpsUrl,
    RPC_URL_8453: optionalHttpsUrl,
    RPC_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8000),
    /** Chains on which tipping is enabled. Empty = tipping disabled. */
    TIPPING_CHAIN_IDS: csv,
    /** Dev only: accept a token address that differs from the issuer's. */
    ALLOW_CUSTOM_TOKEN_ADDRESS: bool,
    TIP_MIN_UNITS: digits.default('10000'),
    TIP_MAX_UNITS: digits.default('100000000'),
    TIP_INTENT_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(3600),
    TIP_INTENTS_PER_HOUR: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(60),
    WALLET_CHALLENGES_PER_HOUR: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20),
    WALLET_RELINK_COOLDOWN_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(2_592_000)
      .default(86_400),
    /** Verify ERC-1271 / ERC-6492 (smart-contract wallet) signatures on chain. */
    SMART_WALLET_SIGNATURES: bool,
    /** Per-IP request cap per minute (coarse; per-DID limits are stricter). */
    RATE_LIMIT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(10)
      .max(100_000)
      .default(300),
    TRUST_PROXY: bool,
    RUN_WORKER: z
      .enum(['true', 'false', '1', '0'])
      .default('true')
      .transform(v => v === 'true' || v === '1'),
    RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(250)
      .max(600_000)
      .default(5000),
    RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
    CLEANUP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(86_400_000)
      .default(600_000),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
    NSID_PREFIX: z.string().default(PLACEHOLDER_NSID_PREFIX),
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
    if (env.SMART_WALLET_SIGNATURES) {
      for (const id of env.ALLOWED_CHAIN_IDS) {
        const rpc =
          id === 84532 ? env.RPC_URL_84532 : id === 8453 ? env.RPC_URL_8453 : ''
        if (!rpc) {
          ctx.addIssue({
            code: 'custom',
            path: [`RPC_URL_${id}`],
            message: 'is required when SMART_WALLET_SIGNATURES is enabled',
          })
        }
      }
    }
    // ---- Tipping safety (all environments) ---------------------------------
    const tippingIds = env.TIPPING_CHAIN_IDS.map(Number)
    if (tippingIds.some(n => !Number.isInteger(n) || n <= 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TIPPING_CHAIN_IDS'],
        message: 'must be a comma-separated list of positive integers',
      })
    }
    if (tippingIds.includes(8453)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TIPPING_CHAIN_IDS'],
        message: 'Base mainnet tipping is disabled in Phase 2',
      })
    }
    for (const id of tippingIds) {
      if (!env.ALLOWED_CHAIN_IDS.includes(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['TIPPING_CHAIN_IDS'],
          message: `chain ${id} must also be listed in ALLOWED_CHAIN_IDS`,
        })
      }
      const rpc = id === 84532 ? env.RPC_URL_84532 : env.RPC_URL_8453
      if (!rpc) {
        ctx.addIssue({
          code: 'custom',
          path: [`RPC_URL_${id}`],
          message: 'is required when tipping is enabled on this chain',
        })
      }
      const usdc = id === 84532 ? env.USDC_ADDRESS_84532 : env.USDC_ADDRESS_8453
      if (!usdc) {
        ctx.addIssue({
          code: 'custom',
          path: [`USDC_ADDRESS_${id}`],
          message: 'is required when tipping is enabled on this chain',
        })
      } else if (
        !env.ALLOW_CUSTOM_TOKEN_ADDRESS &&
        usdc.toLowerCase() !== ISSUER_PUBLISHED_USDC[id]?.toLowerCase()
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [`USDC_ADDRESS_${id}`],
          message:
            'does not match the issuer-published USDC address for this chain',
        })
      }
    }
    // Cross-field check only when both fields passed their own validation.
    if (
      /^[0-9]{1,40}$/.test(env.TIP_MIN_UNITS) &&
      /^[0-9]{1,40}$/.test(env.TIP_MAX_UNITS)
    ) {
      const min = BigInt(env.TIP_MIN_UNITS)
      if (min <= 0n || min > BigInt(env.TIP_MAX_UNITS)) {
        ctx.addIssue({
          code: 'custom',
          path: ['TIP_MIN_UNITS'],
          message: 'must be positive and not above TIP_MAX_UNITS',
        })
      }
    }
    if (!isValidNsidPrefix(env.NSID_PREFIX)) {
      ctx.addIssue({
        code: 'custom',
        path: ['NSID_PREFIX'],
        message:
          'must be a reverse-DNS name and must not use app.bsky, chat.bsky or com.atproto',
      })
    }

    // ---- Production gate ---------------------------------------------------
    if (env.NODE_ENV === 'production') {
      const prod = (path: string, message: string) =>
        ctx.addIssue({
          code: 'custom',
          path: [path],
          message: `production: ${message}`,
        })
      if (env.NSID_PREFIX === PLACEHOLDER_NSID_PREFIX) {
        prod(
          'NSID_PREFIX',
          'must be set to a namespace under a domain the project controls (the default is a placeholder)',
        )
      }
      if (!env.WEB_APP_ORIGIN.startsWith('https://'))
        prod('WEB_APP_ORIGIN', 'must be https')
      if (env.CORS_ALLOWED_ORIGINS.length === 0)
        prod(
          'CORS_ALLOWED_ORIGINS',
          'must list the allowed web origins explicitly',
        )
      if (
        env.CORS_ALLOWED_ORIGINS.some(
          o => o === '*' || !o.startsWith('https://'),
        )
      ) {
        prod(
          'CORS_ALLOWED_ORIGINS',
          'must contain only https origins and no wildcard',
        )
      }
      if (!env.DATABASE_SSL) prod('DATABASE_SSL', 'must be true')
      if (/localhost|127\.0\.0\.1|%3A\d+$/.test(env.SERVICE_DID))
        prod('SERVICE_DID', 'must not be a localhost DID')
      if (
        env.SERVICE_DID.startsWith('did:web:') &&
        !env.SERVICE_PUBLIC_URL?.startsWith('https://')
      ) {
        prod(
          'SERVICE_PUBLIC_URL',
          'is required and must be https for a did:web service',
        )
      }
      for (const [k, v] of [
        ['RPC_URL_84532', env.RPC_URL_84532],
        ['RPC_URL_8453', env.RPC_URL_8453],
      ] as const) {
        if (v && !v.startsWith('https://')) prod(k, 'must be https')
      }
      if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace')
        prod('LOG_LEVEL', 'must not be debug or trace')
      if (env.ALLOW_CUSTOM_TOKEN_ADDRESS)
        prod('ALLOW_CUSTOM_TOKEN_ADDRESS', 'is not allowed')
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
  | 'USDC_ADDRESS_84532'
  | 'USDC_ADDRESS_8453'
  | 'TIPPING_CHAIN_IDS'
  | 'TIP_MIN_UNITS'
  | 'TIP_MAX_UNITS'
> & {
  /** Chains with tipping enabled (never includes Base mainnet). */
  TIPPING_CHAIN_IDS: number[]
  /** Inclusive tip bounds in token base units. */
  TIP_MIN_UNITS: bigint
  TIP_MAX_UNITS: bigint
  /** RPC endpoint per chain id; missing key means "not configured". */
  RPC_URLS: Record<number, string>
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
  const {
    USDC_ADDRESS_84532,
    USDC_ADDRESS_8453,
    TIPPING_CHAIN_IDS,
    TIP_MIN_UNITS,
    TIP_MAX_UNITS,
    ...rest
  } = parsed.data
  const RPC_URLS: Record<number, string> = {}
  if (rest.RPC_URL_84532) RPC_URLS[84532] = rest.RPC_URL_84532
  if (rest.RPC_URL_8453) RPC_URLS[8453] = rest.RPC_URL_8453
  const USDC_ADDRESSES: Record<number, string> = {}
  if (USDC_ADDRESS_84532) USDC_ADDRESSES[84532] = USDC_ADDRESS_84532
  if (USDC_ADDRESS_8453) USDC_ADDRESSES[8453] = USDC_ADDRESS_8453
  return {
    ...rest,
    TIPPING_CHAIN_IDS: TIPPING_CHAIN_IDS.map(Number),
    TIP_MIN_UNITS: BigInt(TIP_MIN_UNITS),
    TIP_MAX_UNITS: BigInt(TIP_MAX_UNITS),
    RPC_URLS,
    SIWE_DOMAIN: new URL(rest.WEB_APP_ORIGIN).host,
    USDC_ADDRESSES,
  }
}
