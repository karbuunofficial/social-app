import {getAddress, type Hex} from 'viem'
import {describe, expect, it} from 'vitest'

import {ViemChainReader} from '../src/chain/reader.ts'
import {buildChainConfigs} from '../src/payments/chains.ts'
import {ERC20_TRANSFER_TOPIC} from '../src/payments/erc20.ts'
import {evaluateTransaction} from '../src/payments/receipt.ts'
import {
  TokenVerificationError,
  verifyUsdcToken,
} from '../src/payments/token-check.ts'
import {OTHER_TOKEN, USDC} from './helpers/chain.ts'
import {findRealTransfer} from './helpers/live.ts'

/**
 * Read-only checks against the REAL Base Sepolia chain. No transactions are
 * sent and no keys exist. Skipped unless BASE_SEPOLIA_RPC_URL is set.
 */
const rpc = process.env.BASE_SEPOLIA_RPC_URL
const CHAIN = 84532

describe.skipIf(!rpc)('real Base Sepolia (read-only)', () => {
  const reader = new ViemChainReader({[CHAIN]: rpc!}, 15_000)
  const chains = buildChainConfigs({
    ALLOWED_CHAIN_IDS: [CHAIN],
    USDC_ADDRESSES: {[CHAIN]: USDC},
  })
  const chain = chains.get(CHAIN)!

  it('serves chain id 84532', async () => {
    expect(await reader.getChainId(CHAIN)).toBe(CHAIN)
    expect(await reader.getBlockNumber(CHAIN)).toBeGreaterThan(1_000_000n)
  })

  it('verifies the issuer-published USDC contract on chain', async () => {
    expect(await verifyUsdcToken(reader, chain)).toEqual({
      chainId: CHAIN,
      address: USDC,
      symbol: 'USDC',
      decimals: 6,
    })
    expect(await reader.readErc20Metadata(CHAIN, USDC)).toEqual({
      symbol: 'USDC',
      decimals: 6,
    })
  })

  it('refuses a real contract that is not USDC (WETH predeploy)', async () => {
    const weth = getAddress('0x4200000000000000000000000000000000000006')
    const c = buildChainConfigs({
      ALLOWED_CHAIN_IDS: [CHAIN],
      USDC_ADDRESSES: {[CHAIN]: weth},
    }).get(CHAIN)!
    await expect(
      verifyUsdcToken(reader, c, {allowCustomAddress: true}),
    ).rejects.toThrow(/symbol is "WETH"/)
  })

  it('refuses an address with no contract code', async () => {
    const eoa = getAddress('0x000000000000000000000000000000000000dEaD')
    const c = buildChainConfigs({
      ALLOWED_CHAIN_IDS: [CHAIN],
      USDC_ADDRESSES: {[CHAIN]: eoa},
    }).get(CHAIN)!
    await expect(
      verifyUsdcToken(reader, c, {allowCustomAddress: true}),
    ).rejects.toBeInstanceOf(TokenVerificationError)
  })

  it('returns null for a transaction that does not exist', async () => {
    expect(
      await reader.getTransactionReceipt(CHAIN, `0x${'12'.repeat(32)}`),
    ).toBeNull()
  })

  describe('a real USDC transfer', () => {
    const realTransfer = () => findRealTransfer(reader, CHAIN)

    it('is judged correctly by the reconciliation logic', async ctx => {
      const t = await realTransfer()
      // Reported as SKIPPED (never as a silent pass) if the scanned window had
      // no suitable transfer.
      if (!t) return ctx.skip()
      console.log(
        `judged real transfer: block ${t.receipt.blockNumber} ${t.receipt.blockHash} ${t.amount} units`,
      )
      const expected = {token: USDC, from: t.from, to: t.to, amount: t.amount}
      const judge = (
        over: Partial<typeof expected>,
        head = t.head,
        prev?: Hex | null,
      ) =>
        evaluateTransaction({
          expected: {...expected, ...over},
          receipt: t.receipt,
          head,
          requiredConfirmations: chain.requiredConfirmations,
          previousBlockHash: prev,
        })

      expect(judge({})).toEqual({kind: 'confirmed'})
      // Too few confirmations.
      expect(judge({}, t.receipt.blockNumber + 1n)).toEqual({
        kind: 'pending',
        reason: 'awaiting_confirmations',
      })
      // Tampered expectations all fail against the same real receipt.
      expect(judge({amount: t.amount + 1n})).toMatchObject({
        kind: 'failed',
        reason: 'no_matching_transfer',
      })
      expect(judge({amount: t.amount - 1n})).toMatchObject({kind: 'failed'})
      expect(judge({token: OTHER_TOKEN})).toMatchObject({kind: 'failed'})
      expect(
        judge({to: getAddress('0x00000000000000000000000000000000000bAd01')}),
      ).toMatchObject({kind: 'failed'})
      expect(
        judge({from: getAddress('0x00000000000000000000000000000000000bAd02')}),
      ).toMatchObject({kind: 'failed'})
      // A different recorded block hash means the block was replaced.
      expect(judge({}, t.head, `0x${'ee'.repeat(32)}`)).toEqual({
        kind: 'reorged',
      })
      // Same hash as recorded: no reorg.
      expect(judge({}, t.head, t.receipt.blockHash)).toEqual({
        kind: 'confirmed',
      })
      // Sanity: the log really is a Transfer from the token.
      expect(
        t.receipt.logs.some(l => l.topics[0] === ERC20_TRANSFER_TOPIC),
      ).toBe(true)
    })
  })
})
