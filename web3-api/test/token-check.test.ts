import {type Address, getAddress, type Hex} from 'viem'
import {describe, expect, it} from 'vitest'

import {type ChainReader} from '../src/chain/reader.ts'
import {buildChainConfigs} from '../src/payments/chains.ts'
import {
  TokenVerificationError,
  verifyUsdcToken,
} from '../src/payments/token-check.ts'

const USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e')

function reader(
  over: Partial<{
    chainId: number
    code: Hex
    symbol: string
    decimals: number
  }> = {},
): ChainReader {
  const o = {
    chainId: 84532,
    code: '0x6080' as Hex,
    symbol: 'USDC',
    decimals: 6,
    ...over,
  }
  return {
    getChainId: () => Promise.resolve(o.chainId),
    getCode: () => Promise.resolve(o.code),
    readErc20Metadata: () =>
      Promise.resolve({symbol: o.symbol, decimals: o.decimals}),
    getTransactionReceipt: () => Promise.resolve(null),
    getBlockNumber: () => Promise.resolve(1n),
  }
}

const chain = (usdc: Record<number, string> = {84532: USDC}, ids = [84532]) =>
  buildChainConfigs({ALLOWED_CHAIN_IDS: ids, USDC_ADDRESSES: usdc}).get(
    ids[0]!,
  )!

const fails = async (p: Promise<unknown>, re: RegExp) => {
  await expect(p).rejects.toBeInstanceOf(TokenVerificationError)
  await expect(p).rejects.toThrow(re)
}

describe('verifyUsdcToken', () => {
  it('accepts the genuine token', async () => {
    const t = await verifyUsdcToken(reader(), chain())
    expect(t).toEqual({
      chainId: 84532,
      address: USDC,
      symbol: 'USDC',
      decimals: 6,
    })
  })

  it('rejects a wrong chain id from the RPC', async () => {
    await fails(
      verifyUsdcToken(reader({chainId: 1}), chain()),
      /RPC serves chain 1/,
    )
  })

  it('rejects an address with no contract code', async () => {
    await fails(
      verifyUsdcToken(reader({code: '0x'}), chain()),
      /no contract code/,
    )
  })

  it('rejects the wrong symbol', async () => {
    await fails(verifyUsdcToken(reader({symbol: 'FAKE'}), chain()), /symbol/)
  })

  it('rejects the wrong decimals (a classic source of 10^12 mistakes)', async () => {
    await fails(
      verifyUsdcToken(reader({decimals: 18}), chain()),
      /decimals is 18/,
    )
  })

  it('rejects an address that is not the issuer-published one', async () => {
    const other = '0x2222222222222222222222222222222222222222'
    await fails(
      verifyUsdcToken(reader(), chain({84532: other})),
      /issuer-published/,
    )
    // A dev override still runs every on-chain check.
    await expect(
      verifyUsdcToken(reader(), chain({84532: other}), {
        allowCustomAddress: true,
      }),
    ).resolves.toMatchObject({address: getAddress(other)})
    await fails(
      verifyUsdcToken(reader({symbol: 'X'}), chain({84532: other}), {
        allowCustomAddress: true,
      }),
      /symbol/,
    )
  })

  it('refuses mainnet outright, even with a correct address', async () => {
    const main = buildChainConfigs({
      ALLOWED_CHAIN_IDS: [8453],
      USDC_ADDRESSES: {8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'},
    }).get(8453)!
    await fails(
      verifyUsdcToken(reader({chainId: 8453}), main),
      /mainnet payments are disabled/,
    )
  })

  it('rejects a missing address', async () => {
    await fails(verifyUsdcToken(reader(), chain({})), /no address configured/)
  })

  it('propagates RPC failures instead of assuming the token is fine', async () => {
    const r: ChainReader = {
      ...reader(),
      getChainId: () => Promise.reject(new Error('rpc down')),
    }
    await expect(verifyUsdcToken(r, chain())).rejects.toThrow('rpc down')
    expect(r as unknown as Address).toBeDefined()
  })
})
