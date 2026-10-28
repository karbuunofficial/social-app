import {
  type Address,
  type Chain,
  createPublicClient,
  getAddress,
  type Hex,
  http,
  type PublicClient,
  TransactionReceiptNotFoundError,
} from 'viem'
import {base, baseSepolia} from 'viem/chains'

import {type ChainReceipt} from '../payments/receipt.ts'

export type Erc20Metadata = {symbol: string; decimals: number}

/**
 * Why an RPC read failed. `timeout` and `unavailable` are transient and must
 * leave payment state untouched; the caller retries later.
 */
export class RpcError extends Error {
  readonly kind: 'timeout' | 'unavailable' | 'invalid_response'

  constructor(kind: RpcError['kind'], message: string) {
    super(message)
    this.name = 'RpcError'
    this.kind = kind
  }
}

/**
 * Read-only access to a chain. It is never given a signing key: nothing in this
 * service can send a transaction.
 */
export interface ChainReader {
  getChainId(chainId: number): Promise<number>
  getCode(chainId: number, address: Address): Promise<Hex | undefined>
  readErc20Metadata(chainId: number, token: Address): Promise<Erc20Metadata>
  /** Null when the node does not know the transaction (not mined or dropped). */
  getTransactionReceipt(
    chainId: number,
    hash: Hex,
  ): Promise<ChainReceipt | null>
  getBlockNumber(chainId: number): Promise<bigint>
}

const erc20MetadataAbi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'string'}],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint8'}],
  },
] as const

const CHAINS: Record<number, Chain> = {
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
}

function classify(e: unknown): RpcError {
  const name = (e as {name?: string} | null)?.name ?? ''
  const text = String((e as {message?: string} | null)?.message ?? '')
  if (name === 'TimeoutError' || /timed out|timeout|aborted/i.test(text)) {
    return new RpcError('timeout', 'RPC request timed out')
  }
  if (
    /HttpRequestError|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|502|503|504|429/i.test(
      name + text,
    )
  ) {
    return new RpcError('unavailable', 'RPC endpoint unavailable')
  }
  return new RpcError('invalid_response', 'Unexpected RPC response')
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof RpcError) throw e
    throw classify(e)
  }
}

export class ViemChainReader implements ChainReader {
  private readonly urls: Record<number, string>
  private readonly timeoutMs: number
  private readonly clients = new Map<number, PublicClient>()

  constructor(urls: Record<number, string>, timeoutMs: number) {
    this.urls = urls
    this.timeoutMs = timeoutMs
  }

  /** Exposed for on-chain signature verification (same endpoints and limits). */
  client(chainId: number): PublicClient {
    let c = this.clients.get(chainId)
    if (!c) {
      const url = this.urls[chainId]
      const chain = CHAINS[chainId]
      if (!url || !chain)
        throw new RpcError('unavailable', 'chain not configured')
      c = createPublicClient({
        chain,
        // One attempt per call: retries and backoff belong to the reconciler,
        // which can record them, rather than being hidden in the transport.
        transport: http(url, {timeout: this.timeoutMs, retryCount: 0}),
      })
      this.clients.set(chainId, c)
    }
    return c
  }

  getChainId(chainId: number) {
    return guard(() => this.client(chainId).getChainId())
  }

  getCode(chainId: number, address: Address) {
    return guard(() => this.client(chainId).getCode({address}))
  }

  readErc20Metadata(chainId: number, token: Address) {
    return guard(async () => {
      const c = this.client(chainId)
      const [symbol, decimals] = await Promise.all([
        c.readContract({
          address: token,
          abi: erc20MetadataAbi,
          functionName: 'symbol',
        }),
        c.readContract({
          address: token,
          abi: erc20MetadataAbi,
          functionName: 'decimals',
        }),
      ])
      return {symbol, decimals: Number(decimals)}
    })
  }

  getBlockNumber(chainId: number) {
    return guard(() => this.client(chainId).getBlockNumber())
  }

  getTransactionReceipt(chainId: number, hash: Hex) {
    return guard(async () => {
      try {
        const r = await this.client(chainId).getTransactionReceipt({hash})
        return {
          status: r.status,
          blockNumber: r.blockNumber,
          blockHash: r.blockHash,
          logs: r.logs.map(l => ({
            address: getAddress(l.address),
            topics: l.topics as readonly Hex[],
            data: l.data,
          })),
        } satisfies ChainReceipt
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null
        throw e
      }
    })
  }
}
