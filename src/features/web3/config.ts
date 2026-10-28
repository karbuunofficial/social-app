export const BASE_MAINNET_CHAIN_ID = 8453
export const BASE_SEPOLIA_CHAIN_ID = 84532

export type Web3Network = {
  chainId: number
  name: string
  isTestnet: boolean
}

export const BASE_MAINNET: Web3Network = {
  chainId: BASE_MAINNET_CHAIN_ID,
  name: 'Base',
  isTestnet: false,
}

export const BASE_SEPOLIA: Web3Network = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  name: 'Base Sepolia',
  isTestnet: true,
}

/**
 * Picks the network the app expects the wallet to be on. Anything other than
 * the exact value `base` resolves to Base Sepolia, so a missing or mistyped
 * variable can never point the app at a network holding real funds.
 */
export function resolveTargetNetwork(raw: string | undefined): Web3Network {
  return raw?.trim().toLowerCase() === 'base' ? BASE_MAINNET : BASE_SEPOLIA
}

export const TARGET_NETWORK: Web3Network = resolveTargetNetwork(
  process.env.EXPO_PUBLIC_WEB3_NETWORK,
)

/**
 * The thirdweb client ID is public by design (it is shipped to browsers and
 * restricted by domain in the thirdweb dashboard). The thirdweb secret key must
 * never be placed in any `EXPO_PUBLIC_*` variable.
 */
const RAW_CLIENT_ID: string | undefined =
  process.env.EXPO_PUBLIC_THIRDWEB_CLIENT_ID

export const THIRDWEB_CLIENT_ID: string = RAW_CLIENT_ID?.trim() ?? ''

/**
 * Human-readable name for a chain ID reported by a wallet.
 */
export function getNetworkName(chainId: number): string {
  if (chainId === BASE_MAINNET_CHAIN_ID) return BASE_MAINNET.name
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return BASE_SEPOLIA.name
  return `Chain ${chainId}`
}

const RAW_API_MODE: string | undefined = process.env.EXPO_PUBLIC_WEB3_API_MODE
const RAW_SERVICE_DID: string | undefined =
  process.env.EXPO_PUBLIC_WEB3_SERVICE_DID
const RAW_API_URL: string | undefined = process.env.EXPO_PUBLIC_WEB3_API_URL
const RAW_NSID_PREFIX: string | undefined =
  process.env.EXPO_PUBLIC_WEB3_NSID_PREFIX

/**
 * How the app reaches `web3-api`. `proxy` (default) goes through the user's
 * PDS; `direct` mints a fresh service-auth token per call. Neither stores a
 * credential. Unset service DID means "not configured".
 */
export function resolveApiMode(raw: string | undefined): 'proxy' | 'direct' {
  return raw?.trim() === 'direct' ? 'direct' : 'proxy'
}

export const WEB3_API = {
  mode: resolveApiMode(RAW_API_MODE),
  serviceDid: RAW_SERVICE_DID?.trim() ?? '',
  baseUrl: RAW_API_URL?.trim() ?? '',
  nsidPrefix: RAW_NSID_PREFIX?.trim() || 'app.web3',
}

export const isWeb3ApiConfigured = WEB3_API.serviceDid !== ''
