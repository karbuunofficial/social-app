import {
  type Address,
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  pad,
  parseAbi,
} from 'viem'
import {describe, expect, it} from 'vitest'

import {RpcError} from '../src/chain/reader.ts'
import {AppError} from '../src/errors.ts'
import {SmartWalletAwareVerifier} from '../src/wallet/signature-verifier.ts'
import {
  TEST_FACTORY_RUNTIME,
  TEST_WALLET_RUNTIME,
} from './contracts/bytecode.ts'
import {newWallet} from './helpers/fixtures.ts'
import {
  overridingClient,
  type StateOverrides,
} from './helpers/override-client.ts'

/**
 * ERC-1271 / ERC-6492 verification executed on a REAL Base Sepolia EVM.
 *
 * Nothing is deployed and no funds are used: test contracts (see
 * `contracts/TestWallet.sol`) are injected with `eth_call` state overrides, and
 * viem's own ERC-6492 "universal signature validator" runs on the node.
 *
 * What this proves: the production verification path (`SmartWalletAwareVerifier`
 * + viem `verifyMessage`) accepts valid contract-wallet signatures, rejects
 * invalid ones, and fails closed on RPC errors.
 * What it does NOT prove: compatibility with thirdweb's own account contracts.
 * Skipped unless BASE_SEPOLIA_RPC_URL is set.
 */
const rpc = process.env.BASE_SEPOLIA_RPC_URL
const WALLET = '0x00000000000000000000000000000000000a11ce' as Address
const FACTORY = '0x00000000000000000000000000000000000fac70' as Address
const MAGIC =
  '0x6492649264926492649264926492649264926492649264926492649264926492'
const CHAIN = 84532
const MESSAGE = 'Link this wallet to your account.\n\nNonce: abc12345'

const factoryAbi = parseAbi([
  'function createAccount(address owner) returns (address)',
  'function accountAddress(address owner) view returns (address)',
])

const walletAt = (owner: Address): StateOverrides => ({
  [WALLET]: {
    code: TEST_WALLET_RUNTIME,
    stateDiff: {[pad('0x00')]: pad(owner)},
  },
})

const factoryOverride: StateOverrides = {
  [FACTORY]: {code: TEST_FACTORY_RUNTIME},
}

const verifierFor = (overrides: StateOverrides) => {
  const client = overridingClient(rpc!, overrides)
  return new SmartWalletAwareVerifier(
    {
      // `eth_getCode` is not an `eth_call`, so the state override does not
      // apply to it; mirror what a real chain would report for the injected
      // contract so the verifier sees the same thing it would in production.
      getCode: async (_c, address) =>
        overrides[address]?.code ?? client.getCode({address}),
    },
    (_chainId, p) => client.verifyMessage(p),
  )
}

const wrap6492 = (factory: Address, data: Hex, inner: Hex): Hex =>
  concat([
    encodeAbiParameters(
      [{type: 'address'}, {type: 'bytes'}, {type: 'bytes'}],
      [factory, data, inner],
    ),
    MAGIC,
  ])

describe.skipIf(!rpc)(
  'smart-contract wallet signatures on a real EVM (Base Sepolia)',
  () => {
    describe('ERC-1271 (deployed contract wallet)', () => {
      const owner = newWallet()

      it('accepts a signature by the wallet owner', async () => {
        const signature = await owner.signMessage({message: MESSAGE})
        const ok = await verifierFor(walletAt(owner.address)).verify({
          address: WALLET,
          message: MESSAGE,
          signature,
          chainId: CHAIN,
        })
        expect(ok).toBe(true)
      })

      it('rejects a signature by anyone else', async () => {
        const signature = await newWallet().signMessage({message: MESSAGE})
        const ok = await verifierFor(walletAt(owner.address)).verify({
          address: WALLET,
          message: MESSAGE,
          signature,
          chainId: CHAIN,
        })
        expect(ok).toBe(false)
      })

      it('rejects a valid signature over a different message', async () => {
        const signature = await owner.signMessage({message: 'something else'})
        const ok = await verifierFor(walletAt(owner.address)).verify({
          address: WALLET,
          message: MESSAGE,
          signature,
          chainId: CHAIN,
        })
        expect(ok).toBe(false)
      })

      it('rejects when the address has no contract and the signature is not its own', async () => {
        const signature = await owner.signMessage({message: MESSAGE})
        // No override: WALLET has no code on the real chain, and owner != WALLET.
        const ok = await verifierFor({}).verify({
          address: WALLET,
          message: MESSAGE,
          signature,
          chainId: CHAIN,
        })
        expect(ok).toBe(false)
      })

      it('still accepts a plain EOA without any RPC call', async () => {
        const signature = await owner.signMessage({message: MESSAGE})
        const never = new SmartWalletAwareVerifier(
          {
            getCode: () =>
              Promise.reject(new RpcError('unavailable', 'must not be called')),
          },
          () =>
            Promise.reject(new RpcError('unavailable', 'must not be called')),
        )
        expect(
          await never.verify({
            address: owner.address,
            message: MESSAGE,
            signature,
            chainId: CHAIN,
          }),
        ).toBe(true)
      })
    })

    describe('ERC-6492 (wallet not deployed yet)', () => {
      const owner = newWallet()

      async function counterfactual() {
        const client = overridingClient(rpc!, factoryOverride)
        const out = await client.call({
          to: FACTORY,
          data: encodeFunctionData({
            abi: factoryAbi,
            functionName: 'accountAddress',
            args: [owner.address],
          }),
        })
        const [predicted] = decodeAbiParameters([{type: 'address'}], out.data!)
        const create = encodeFunctionData({
          abi: factoryAbi,
          functionName: 'createAccount',
          args: [owner.address],
        })
        return {predicted, create}
      }

      it("accepts the owner's signature for a wallet that does not exist yet", async () => {
        const {predicted, create} = await counterfactual()
        // The predicted address really has no code on the live chain.
        expect(
          await overridingClient(rpc!, {}).getCode({address: predicted}),
        ).toBeUndefined()
        const inner = await owner.signMessage({message: MESSAGE})
        const ok = await verifierFor(factoryOverride).verify({
          address: predicted,
          message: MESSAGE,
          signature: wrap6492(FACTORY, create, inner),
          chainId: CHAIN,
        })
        expect(ok).toBe(true)
      })

      it('rejects a 6492 signature made by a different key', async () => {
        const {predicted, create} = await counterfactual()
        const inner = await newWallet().signMessage({message: MESSAGE})
        const ok = await verifierFor(factoryOverride).verify({
          address: predicted,
          message: MESSAGE,
          signature: wrap6492(FACTORY, create, inner),
          chainId: CHAIN,
        })
        expect(ok).toBe(false)
      })

      it('rejects a 6492 signature presented for an address it would not deploy', async () => {
        const {create} = await counterfactual()
        const inner = await owner.signMessage({message: MESSAGE})
        const ok = await verifierFor(factoryOverride).verify({
          address: '0x00000000000000000000000000000000dead0001',
          message: MESSAGE,
          signature: wrap6492(FACTORY, create, inner),
          chainId: CHAIN,
        })
        expect(ok).toBe(false)
      })

      it('rejects a malformed 6492 payload', async () => {
        const ok = await verifierFor(factoryOverride).verify({
          address: WALLET,
          message: MESSAGE,
          signature: concat(['0x1234', MAGIC]),
          chainId: CHAIN,
        })
        expect(ok).toBe(false)
      })
    })

    describe('failing closed', () => {
      it('turns RPC failure into a 503, never into "valid"', async () => {
        const down = new SmartWalletAwareVerifier(
          {getCode: () => Promise.resolve('0x6080' as Hex)},
          () => Promise.reject(new RpcError('timeout', 'slow')),
        )
        const signature = await newWallet().signMessage({message: MESSAGE})
        await expect(
          down.verify({
            address: WALLET,
            message: MESSAGE,
            signature,
            chainId: CHAIN,
          }),
        ).rejects.toMatchObject({
          statusCode: 503,
          code: 'verification_unavailable',
        })
        await expect(
          down.verify({
            address: WALLET,
            message: MESSAGE,
            signature,
            chainId: CHAIN,
          }),
        ).rejects.toBeInstanceOf(AppError)
      })
    })
  },
)
