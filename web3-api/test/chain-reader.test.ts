import {createServer, type Server} from 'node:http'
import {type AddressInfo} from 'node:net'

import {afterEach, describe, expect, it} from 'vitest'

import {RpcError, ViemChainReader} from '../src/chain/reader.ts'

let server: Server | undefined
afterEach(
  () => new Promise<void>(r => (server ? server.close(() => r()) : r())),
)

async function rpc(handler: Parameters<typeof createServer>[1]) {
  server = createServer(handler)
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const HASH = `0x${'ab'.repeat(32)}` as const

describe('ViemChainReader failure handling', () => {
  it('maps a hung RPC to a timeout error', async () => {
    const url = await rpc(() => {
      /* never respond */
    })
    const reader = new ViemChainReader({84532: url}, 300)
    const started = Date.now()
    await expect(reader.getBlockNumber(84532)).rejects.toMatchObject({
      kind: 'timeout',
    })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('maps HTTP 5xx and connection failures to unavailable', async () => {
    const url = await rpc((_req, res) => {
      res.writeHead(503).end('busy')
    })
    await expect(
      new ViemChainReader({84532: url}, 2000).getBlockNumber(84532),
    ).rejects.toMatchObject({kind: 'unavailable'})
    await expect(
      new ViemChainReader({84532: 'http://127.0.0.1:1'}, 2000).getBlockNumber(
        84532,
      ),
    ).rejects.toBeInstanceOf(RpcError)
  })

  it('treats an unknown transaction as null, not an error', async () => {
    const url = await rpc((req, res) => {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        const {id} = JSON.parse(body) as {id: number}
        res
          .writeHead(200, {'content-type': 'application/json'})
          .end(JSON.stringify({jsonrpc: '2.0', id, result: null}))
      })
    })
    expect(
      await new ViemChainReader({84532: url}, 2000).getTransactionReceipt(
        84532,
        HASH,
      ),
    ).toBeNull()
  })

  it('rejects an unconfigured chain', async () => {
    await expect(
      new ViemChainReader({}, 1000).getBlockNumber(84532),
    ).rejects.toBeInstanceOf(RpcError)
  })
})
