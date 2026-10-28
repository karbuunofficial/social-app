import {type Address} from 'viem'

import {type ViemChainReader} from '../../src/chain/reader.ts'
import {hasMatchingTransfer} from '../../src/payments/receipt.ts'
import {USDC} from './chain.ts'

/**
 * Finds a recent real USDC Transfer on the chain behind `reader`, using only
 * read-only RPC calls. Returns null when the scanned window has none.
 */
export async function findRealTransfer(
  reader: ViemChainReader,
  chainId: number,
) {
  const client = reader.client(chainId)
  const head = await client.getBlockNumber()
  for (let i = 1n; i <= 40n; i++) {
    const to = head - 10n - (i - 1n) * 190n
    const logs = await client.getLogs({
      address: USDC,
      fromBlock: to - 189n,
      toBlock: to,
      event: {
        type: 'event',
        name: 'Transfer',
        inputs: [
          {type: 'address', name: 'from', indexed: true},
          {type: 'address', name: 'to', indexed: true},
          {type: 'uint256', name: 'value'},
        ],
      },
    })
    for (const log of logs) {
      const receipt = await reader.getTransactionReceipt(
        chainId,
        log.transactionHash,
      )
      if (!receipt) continue
      const from = log.args.from as Address
      const dest = log.args.to as Address
      const amount = log.args.value as bigint
      // Only transactions with exactly one identical matching transfer.
      if (hasMatchingTransfer(receipt, {token: USDC, from, to: dest, amount})) {
        return {
          hash: log.transactionHash,
          receipt,
          from,
          to: dest,
          amount,
          head: await client.getBlockNumber(),
        }
      }
    }
  }
  return null
}
