import {type Address} from 'viem'
import {getAddress} from 'viem'

import {type Config} from '../config.ts'

export const BASE_MAINNET_CHAIN_ID = 8453
export const BASE_SEPOLIA_CHAIN_ID = 84532

/** USDC has 6 decimals. This is a property of the token, not of the chain. */
export const USDC_DECIMALS = 6

export type ChainConfig = {
  chainId: number
  name: string
  isTestnet: boolean
  /**
   * Blocks that must sit on top of a transaction's block before it is treated
   * as confirmed. Tune with real reorg data before mainnet.
   */
  requiredConfirmations: number
  /** Undefined until the operator configures a verified address. */
  usdcAddress: Address | undefined
  /** Block explorer base URL, for transaction links in the UI. */
  explorerUrl: string
  /** Blocks after which a confirmed payment is no longer re-checked. */
  finalityDepth: number
}

const KNOWN_CHAINS: Record<
  number,
  Omit<ChainConfig, 'usdcAddress' | 'chainId'>
> = {
  [BASE_MAINNET_CHAIN_ID]: {
    name: 'Base',
    isTestnet: false,
    requiredConfirmations: 20,
    explorerUrl: 'https://basescan.org',
    finalityDepth: 60,
  },
  [BASE_SEPOLIA_CHAIN_ID]: {
    name: 'Base Sepolia',
    isTestnet: true,
    requiredConfirmations: 5,
    explorerUrl: 'https://sepolia.basescan.org',
    finalityDepth: 15,
  },
}

/**
 * Builds the per-chain configuration from validated env. The USDC contract
 * address is NEVER defaulted here: it must come from the operator, taken from
 * the token issuer's official documentation and confirmed on-chain, so an
 * unverified address can never be shipped by accident.
 */
export function buildChainConfigs(
  config: Pick<Config, 'ALLOWED_CHAIN_IDS' | 'USDC_ADDRESSES'>,
): Map<number, ChainConfig> {
  const chains = new Map<number, ChainConfig>()
  for (const chainId of config.ALLOWED_CHAIN_IDS) {
    const known = KNOWN_CHAINS[chainId]
    if (!known) {
      throw new Error(`Unsupported chain id in ALLOWED_CHAIN_IDS: ${chainId}`)
    }
    const raw = config.USDC_ADDRESSES[chainId]
    chains.set(chainId, {
      chainId,
      ...known,
      usdcAddress: raw ? getAddress(raw) : undefined,
    })
  }
  return chains
}

export class UsdcNotConfiguredError extends Error {
  constructor(chainId: number) {
    super(`USDC address is not configured for chain ${chainId}`)
    this.name = 'UsdcNotConfiguredError'
  }
}

/**
 * Returns the configured USDC address or throws, so tipping code cannot run
 * against an unconfigured token.
 */
export function requireUsdcAddress(chain: ChainConfig): Address {
  if (!chain.usdcAddress) throw new UsdcNotConfiguredError(chain.chainId)
  return chain.usdcAddress
}
