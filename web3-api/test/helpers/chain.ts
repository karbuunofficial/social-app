import {
  type Address,
  encodeAbiParameters,
  getAddress,
  type Hex,
  keccak256,
  pad,
  toHex,
} from 'viem'

import {
  type ChainReader,
  type Erc20Metadata,
  type RpcError,
} from '../../src/chain/reader.ts'
import {ERC20_TRANSFER_TOPIC} from '../../src/payments/erc20.ts'
import {type ChainReceipt} from '../../src/payments/receipt.ts'

export const USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
export const OTHER_TOKEN = getAddress(
  '0x2222222222222222222222222222222222222222',
)

export const blockHash = (label: string): Hex => keccak256(toHex(label))
export const txHash = (label: string): Hex => keccak256(toHex(`tx-${label}`))

export function transferLog(o: {
  token?: Address
  from: Address
  to: Address
  amount: bigint
}) {
  return {
    address: o.token ?? USDC,
    topics: [ERC20_TRANSFER_TOPIC, pad(o.from), pad(o.to)] as Hex[],
    data: encodeAbiParameters([{type: 'uint256'}], [o.amount]),
  }
}

export function receipt(o: {
  block: bigint
  hash: Hex
  logs: ReturnType<typeof transferLog>[]
  status?: 'success' | 'reverted'
}): ChainReceipt {
  return {
    status: o.status ?? 'success',
    blockNumber: o.block,
    blockHash: o.hash,
    logs: o.logs,
  }
}

/** A scriptable chain. Nothing here talks to a network. */
export class MockChain implements ChainReader {
  head = 1000n
  receipts = new Map<string, ChainReceipt | null>()
  /** Errors thrown by the next N calls to getTransactionReceipt / getBlockNumber. */
  failNext: RpcError[] = []
  receiptCalls = 0
  metadata: Erc20Metadata = {symbol: 'USDC', decimals: 6}

  getChainId() {
    return Promise.resolve(84532)
  }
  getCode() {
    return Promise.resolve('0x6080' as Hex)
  }
  readErc20Metadata() {
    return Promise.resolve(this.metadata)
  }
  getBlockNumber() {
    const err = this.failNext.shift()
    return err ? Promise.reject(err) : Promise.resolve(this.head)
  }
  getTransactionReceipt(_chainId: number, hash: Hex) {
    this.receiptCalls++
    const err = this.failNext.shift()
    if (err) return Promise.reject(err)
    return Promise.resolve(this.receipts.get(hash.toLowerCase()) ?? null)
  }
  set(hash: Hex, r: ChainReceipt | null) {
    this.receipts.set(hash.toLowerCase(), r)
  }
}
