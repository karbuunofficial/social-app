import {type Address, type Hex, recoverMessageAddress} from 'viem'

import {type ChainReader, RpcError} from '../chain/reader.ts'
import {serviceUnavailable, unprocessable} from '../errors.ts'

export type VerifyParams = {
  address: Address
  message: string
  signature: Hex
  chainId: number
}

/**
 * Proves that `signature` over `message` was produced by `address`.
 *
 * Two very different cases:
 * - Externally owned accounts (EOA): verified offline by recovering the signer.
 * - Smart-contract wallets (ERC-1271 deployed, ERC-6492 not yet deployed), such
 *   as thirdweb smart accounts and Coinbase Smart Wallet: need an on-chain call.
 */
export interface WalletSignatureVerifier {
  verify(params: VerifyParams): Promise<boolean>
}

const EOA_SIGNATURE = /^0x[0-9a-fA-F]{130}$/

/** ERC-6492 wrapped signatures end with this 32-byte magic suffix. */
const ERC6492_MAGIC =
  '6492649264926492649264926492649264926492649264926492649264926492'

export function isEoaShaped(signature: Hex): boolean {
  return EOA_SIGNATURE.test(signature)
}

export function isErc6492(signature: Hex): boolean {
  return signature.toLowerCase().endsWith(ERC6492_MAGIC)
}

/** Offline EOA check. Refuses anything that is not a 65-byte signature. */
export class EoaSignatureVerifier implements WalletSignatureVerifier {
  async verify({address, message, signature}: VerifyParams): Promise<boolean> {
    if (!isEoaShaped(signature)) {
      throw unprocessable(
        'unsupported_signature_type',
        'Smart-contract wallet signatures are not supported',
      )
    }
    try {
      const recovered = await recoverMessageAddress({message, signature})
      return recovered.toLowerCase() === address.toLowerCase()
    } catch {
      return false
    }
  }
}

/** What the on-chain path needs: viem's ERC-6492-aware `verifyMessage`. */
export type OnChainVerify = (
  chainId: number,
  params: {address: Address; message: string; signature: Hex},
) => Promise<boolean>

/**
 * EOA signatures are checked offline first. Anything else (or an EOA-shaped
 * signature for an address that has contract code) goes to an on-chain check
 * through the configured RPC, which handles ERC-1271 and ERC-6492 (including
 * wallets that are not deployed yet).
 *
 * Fails closed: if the RPC is unreachable the result is a 503, never "valid".
 * The caller treats a 503 as an infrastructure error (the challenge is
 * re-opened), unlike a plain `false` (the challenge stays consumed).
 */
export class SmartWalletAwareVerifier implements WalletSignatureVerifier {
  private readonly eoa = new EoaSignatureVerifier()
  private readonly reader: Pick<ChainReader, 'getCode'>
  private readonly onChain: OnChainVerify

  constructor(reader: Pick<ChainReader, 'getCode'>, onChain: OnChainVerify) {
    this.reader = reader
    this.onChain = onChain
  }

  async verify(p: VerifyParams): Promise<boolean> {
    if (isEoaShaped(p.signature) && (await this.eoa.verify(p))) return true

    // From here the signature is either not EOA-shaped, or did not recover to
    // `address`. Only a contract (deployed, or counterfactual via 6492) can
    // still be valid.
    const counterfactual = isErc6492(p.signature)
    if (!counterfactual && isEoaShaped(p.signature)) {
      const code = await this.guard(() =>
        this.reader.getCode(p.chainId, p.address),
      )
      if (!code || code === '0x') return false
    }
    return this.guard(() =>
      this.onChain(p.chainId, {
        address: p.address,
        message: p.message,
        signature: p.signature,
      }),
    )
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof RpcError) {
        throw serviceUnavailable(
          'verification_unavailable',
          'Could not verify the signature right now, please try again',
        )
      }
      // viem throws for malformed signatures and for reverting validators;
      // neither is a valid signature.
      return false as T
    }
  }
}
