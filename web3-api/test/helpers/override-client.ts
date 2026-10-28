import {
  type Address,
  type Chain,
  createPublicClient,
  custom,
  type Hex,
  type PublicClient,
} from 'viem'
import {baseSepolia} from 'viem/chains'

export type StateOverrides = Record<
  Address,
  {code?: Hex; stateDiff?: Record<Hex, Hex>}
>

let id = 0

/**
 * A viem public client against a REAL JSON-RPC endpoint that adds an
 * `eth_call` state override to every call. The real node's EVM then executes
 * real bytecode (viem's universal signature validator, plus test contracts we
 * inject at chosen addresses), so signature verification is exercised on a real
 * EVM without deploying anything or spending funds.
 */
export function overridingClient(
  rpcUrl: string,
  overrides: StateOverrides,
  chain: Chain = baseSepolia,
): PublicClient {
  return createPublicClient({
    chain,
    transport: custom({
      async request({method, params}) {
        const p = (params ?? []) as unknown[]
        const body = {
          jsonrpc: '2.0',
          id: ++id,
          method,
          params:
            method === 'eth_call' ? [p[0], p[1] ?? 'latest', overrides] : p,
        }
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(body),
        })
        const json = (await res.json()) as {
          result?: unknown
          error?: {message: string; code: number; data?: unknown}
        }
        if (json.error) {
          throw Object.assign(new Error(json.error.message), json.error)
        }
        return json.result
      },
    }),
  })
}
