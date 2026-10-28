import {type Address} from 'viem'

import {type ChainReader} from '../chain/reader.ts'
import {type ChainConfig} from './chains.ts'
import {ISSUER_PUBLISHED_USDC} from './issuer-addresses.ts'

/** A token whose identity was confirmed on chain at startup. */
export type VerifiedToken = {
  chainId: number
  address: Address
  symbol: 'USDC'
  decimals: 6
}

export class TokenVerificationError extends Error {
  constructor(chainId: number, reason: string) {
    super(`USDC verification failed for chain ${chainId}: ${reason}`)
    this.name = 'TokenVerificationError'
  }
}

/**
 * Confirms, against the configured RPC, that the configured token really is
 * USDC with 6 decimals on the expected chain. Any mismatch is an error, and the
 * caller must keep tipping disabled for that chain.
 *
 * Checks: the RPC serves the expected chain id; the address has contract code;
 * `symbol()` is "USDC"; `decimals()` is 6; and the address equals the
 * issuer-published one unless a dev override was explicitly allowed.
 */
export async function verifyUsdcToken(
  reader: ChainReader,
  chain: ChainConfig,
  opts: {allowCustomAddress?: boolean} = {},
): Promise<VerifiedToken> {
  const {chainId, usdcAddress} = chain
  if (!usdcAddress)
    throw new TokenVerificationError(chainId, 'no address configured')
  if (chain.isTestnet === false) {
    throw new TokenVerificationError(chainId, 'mainnet payments are disabled')
  }

  const published = ISSUER_PUBLISHED_USDC[chainId]
  if (
    !opts.allowCustomAddress &&
    published?.toLowerCase() !== usdcAddress.toLowerCase()
  ) {
    throw new TokenVerificationError(
      chainId,
      'address does not match the issuer-published address',
    )
  }

  const served = await reader.getChainId(chainId)
  if (served !== chainId) {
    throw new TokenVerificationError(
      chainId,
      `RPC serves chain ${served}, expected ${chainId}`,
    )
  }
  const code = await reader.getCode(chainId, usdcAddress)
  if (!code || code === '0x') {
    throw new TokenVerificationError(chainId, 'no contract code at the address')
  }
  const {symbol, decimals} = await reader.readErc20Metadata(
    chainId,
    usdcAddress,
  )
  if (symbol !== 'USDC') {
    throw new TokenVerificationError(
      chainId,
      `symbol is "${symbol}", expected "USDC"`,
    )
  }
  if (decimals !== 6) {
    throw new TokenVerificationError(
      chainId,
      `decimals is ${decimals}, expected 6`,
    )
  }
  return {chainId, address: usdcAddress, symbol: 'USDC', decimals: 6}
}
