import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
  parseAbi,
  toEventSelector,
} from 'viem'

import {type ChainConfig, requireUsdcAddress} from './chains.ts'

const erc20Abi = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
])

export const ERC20_TRANSFER_TOPIC = toEventSelector(
  'Transfer(address,address,uint256)',
)

/**
 * An unsigned transaction request for the wallet to sign and send. Building
 * this sends nothing and needs no keys.
 */
export type PreparedTransfer = {
  chainId: number
  /** The token contract. */
  to: Address
  data: Hex
  /** Always "0": no native currency is sent. Decimal string of wei. */
  value: '0'
}

export function prepareUsdcTransfer(params: {
  chain: ChainConfig
  recipient: Address
  amount: bigint
}): PreparedTransfer {
  if (params.amount <= 0n) throw new RangeError('amount must be positive')
  return {
    chainId: params.chain.chainId,
    to: requireUsdcAddress(params.chain),
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [getAddress(params.recipient), params.amount],
    }),
    value: '0',
  }
}
