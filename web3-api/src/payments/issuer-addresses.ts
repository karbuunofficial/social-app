/**
 * USDC contract addresses as published by the issuer (Circle):
 * https://developers.circle.com/stablecoins/usdc-contract-addresses
 *
 * Base Sepolia was additionally verified on chain on 2026-10-28: chain id
 * 0x14a34, contract code present, `symbol()` = "USDC", `decimals()` = 6,
 * `version()` = "2". The service re-verifies these facts at startup against
 * the configured RPC (see token-check.ts), so this table is a cross-check for
 * the configured value, not a substitute for the on-chain check.
 *
 * The Base mainnet entry exists only so a mainnet address in configuration can
 * be recognised and refused: mainnet payments are disabled in Phase 2.
 */
export const ISSUER_PUBLISHED_USDC: Readonly<Record<number, string>> = {
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}
