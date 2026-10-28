/** Shapes returned by `web3-api`. Token amounts are decimal STRINGS. */

export type LinkedWallet = {
  id: string
  chainId: number
  /** EIP-55 checksummed. */
  address: string
  verifiedAt: string
}

export type WalletChallenge = {
  challengeId: string
  /** The exact EIP-4361 text the wallet must sign. */
  message: string
  expiresAt: string
}

export type TipToken = {address: string; symbol: 'USDC'; decimals: 6}

export type TipNetworkConfig = {
  chainId: number
  name: string
  isTestnet: boolean
  explorerUrl: string
  requiredConfirmations: number
  token: TipToken
  /** Integer base units, as strings. */
  minUnits: string
  maxUnits: string
  minAmount: string
  maxAmount: string
}

export type Web3ApiConfig = {
  allowedChainIds: number[]
  smartWalletSignatures: boolean
  tipping: TipNetworkConfig[]
}

export type TipStatus =
  | 'created'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'reorged'

export type Tip = {
  id: string
  status: TipStatus
  chainId: number
  senderDid: string
  recipientDid: string
  senderAddress: string
  recipientAddress: string
  token: TipToken
  amountUnits: string
  amount: string
  postUri: string | null
  expiresAt: string
  createdAt: string
  requiredConfirmations: number
  transaction: {
    hash: string
    status: string
    blockNumber: string | null
    confirmations: string | null
    explorerUrl: string
  } | null
}

/** An unsigned ERC-20 transfer for the user's own wallet to sign and send. */
export type PreparedTransfer = {
  chainId: number
  to: string
  data: string
  value: '0'
}

export type TipRecipient =
  | {tippable: false; reason: string}
  | {
      tippable: true
      chainId: number
      recipientAddress: string
      token: TipToken
    }
