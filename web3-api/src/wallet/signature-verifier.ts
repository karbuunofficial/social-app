import {type Address, type Hex, recoverMessageAddress} from 'viem'

import {unprocessable} from '../errors.ts'

/**
 * Proves that `signature` over `message` was produced by `address`.
 *
 * This is an interface because there are two very different cases:
 * externally owned accounts (verified offline by recovering the signer) and
 * smart-contract wallets such as thirdweb in-app or smart accounts
 * (ERC-1271 / ERC-6492, which need an on-chain call). Only the first is
 * implemented in Phase 1.
 */
export interface WalletSignatureVerifier {
  verify(params: {
    address: Address
    message: string
    signature: Hex
  }): Promise<boolean>
}

const EOA_SIGNATURE = /^0x[0-9a-fA-F]{130}$/

export class EoaSignatureVerifier implements WalletSignatureVerifier {
  async verify({
    address,
    message,
    signature,
  }: {
    address: Address
    message: string
    signature: Hex
  }): Promise<boolean> {
    if (!EOA_SIGNATURE.test(signature)) {
      // Longer signatures are contract-wallet (ERC-1271/6492) payloads. Refuse
      // them explicitly rather than guessing.
      throw unprocessable(
        'unsupported_signature_type',
        'Smart-contract wallet signatures are not supported yet',
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
