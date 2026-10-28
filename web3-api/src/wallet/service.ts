import {createHash} from 'node:crypto'

import {getAddress, type Hex, isAddress} from 'viem'
import {
  createSiweMessage,
  generateSiweNonce,
  parseSiweMessage,
  validateSiweMessage,
} from 'viem/siwe'

import {type Config} from '../config.ts'
import {badRequest, conflict, unprocessable} from '../errors.ts'
import {type WalletSignatureVerifier} from './signature-verifier.ts'
import {type UserWallet, type WalletRepository} from './types.ts'

const STATEMENT =
  'Link this wallet to your account. Signing this message does not send a transaction or give anyone access to your funds.'

export type Clock = () => Date

export type WalletLinkConfig = Pick<
  Config,
  | 'SIWE_DOMAIN'
  | 'WEB_APP_ORIGIN'
  | 'ALLOWED_CHAIN_IDS'
  | 'WALLET_CHALLENGE_TTL_SECONDS'
>

export const sha256Hex = (value: string) =>
  createHash('sha256').update(value).digest('hex')

export type PublicWallet = {
  id: string
  chainId: number
  /** EIP-55 checksummed. */
  address: string
  verifiedAt: string
}

export const toPublicWallet = (w: UserWallet): PublicWallet => ({
  id: w.id,
  chainId: w.chainId,
  address: getAddress(w.address),
  verifiedAt: w.verifiedAt.toISOString(),
})

/**
 * Wallet linking by challenge and response.
 *
 *  1. The caller is already authenticated as a DID (see AuthVerifier).
 *  2. {@link createChallenge} issues a short-lived, single-use EIP-4361 message
 *     bound to the DID, wallet, chain and our domain.
 *  3. The user signs it in their wallet.
 *  4. {@link verifyChallenge} consumes the challenge, verifies the signature
 *     server-side, and only then records the wallet as verified for the DID.
 *
 * A wallet is never marked verified without step 4 succeeding.
 */
export class WalletLinkService {
  private readonly repo: WalletRepository
  private readonly signatures: WalletSignatureVerifier
  private readonly config: WalletLinkConfig
  private readonly now: Clock

  constructor(
    repo: WalletRepository,
    signatures: WalletSignatureVerifier,
    config: WalletLinkConfig,
    now: Clock = () => new Date(),
  ) {
    this.repo = repo
    this.signatures = signatures
    this.config = config
    this.now = now
  }

  async createChallenge(
    did: string,
    input: {address: string; chainId: number},
  ) {
    if (!isAddress(input.address, {strict: false})) {
      throw badRequest('invalid_address', 'Invalid wallet address')
    }
    if (!this.config.ALLOWED_CHAIN_IDS.includes(input.chainId)) {
      throw unprocessable('unsupported_chain', 'This chain is not supported')
    }
    const address = input.address.toLowerCase()

    const existing = await this.repo.findLinkByAddress(input.chainId, address)
    if (existing) {
      throw conflict(
        existing.did === did ? 'already_linked' : 'wallet_already_linked',
        existing.did === did
          ? 'This wallet is already linked to your account'
          : 'This wallet is already linked to another account',
      )
    }

    const nonce = generateSiweNonce()
    const issuedAt = this.now()
    const expiresAt = new Date(
      issuedAt.getTime() + this.config.WALLET_CHALLENGE_TTL_SECONDS * 1000,
    )
    const message = createSiweMessage({
      address: getAddress(address),
      chainId: input.chainId,
      domain: this.config.SIWE_DOMAIN,
      nonce,
      uri: this.config.WEB_APP_ORIGIN,
      version: '1',
      statement: STATEMENT,
      issuedAt,
      expirationTime: expiresAt,
      // Binds the DID into what the user signs.
      resources: [did],
    })

    const challenge = await this.repo.withTransaction(async tx => {
      // Duplicate-challenge protection: only one live challenge per DID and
      // wallet may exist, so a newly issued one retires any earlier one.
      await tx.supersedeLiveChallenges(did, address, issuedAt)
      return tx.insertChallenge({
        did,
        chainId: input.chainId,
        address,
        nonceHash: sha256Hex(nonce),
        message,
        expiresAt,
        createdAt: issuedAt,
      })
    })

    return {
      challengeId: challenge.id,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString(),
    }
  }

  async verifyChallenge(
    did: string,
    input: {challengeId: string; signature: Hex},
  ): Promise<{wallet: PublicWallet; created: boolean}> {
    const now = this.now()

    /*
     * Single-use: the challenge is consumed by its own committed statement
     * BEFORE any signature work. It must not share a transaction with the rest
     * of this method, or a failed verification would roll the consumption back
     * and leave the challenge retryable. A failed attempt needs a new
     * challenge.
     */
    const challenge = await this.repo.consumeChallenge(
      input.challengeId,
      did,
      now,
    )
    if (!challenge) {
      // Not found, someone else's, expired and already used are
      // indistinguishable on purpose.
      throw badRequest(
        'invalid_or_expired_challenge',
        'The challenge is invalid, expired or already used',
      )
    }

    const parsed = parseSiweMessage(challenge.message)
    const address = challenge.address as `0x${string}`
    const messageOk =
      parsed.nonce !== undefined &&
      sha256Hex(parsed.nonce) === challenge.nonceHash &&
      parsed.chainId === challenge.chainId &&
      parsed.address?.toLowerCase() === challenge.address &&
      parsed.resources?.length === 1 &&
      parsed.resources[0] === did &&
      validateSiweMessage({
        message: parsed,
        domain: this.config.SIWE_DOMAIN,
        address,
        time: now,
      })
    if (!messageOk) {
      throw badRequest(
        'invalid_or_expired_challenge',
        'The challenge is invalid, expired or already used',
      )
    }

    const valid = await this.signatures.verify({
      address,
      message: challenge.message,
      signature: input.signature,
    })
    if (!valid) {
      throw badRequest('invalid_signature', 'The signature is not valid')
    }

    const {wallet, created} = await this.repo.insertLink({
      did,
      chainId: challenge.chainId,
      address: challenge.address,
      verifiedAt: now,
    })
    if (wallet.did !== did) {
      // Another DID verified the same wallet first.
      throw conflict(
        'wallet_already_linked',
        'This wallet is already linked to another account',
      )
    }
    return {wallet: toPublicWallet(wallet), created}
  }

  async listWallets(did: string): Promise<PublicWallet[]> {
    return (await this.repo.listLinksForDid(did)).map(toPublicWallet)
  }
}
