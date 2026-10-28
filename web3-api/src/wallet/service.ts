import {createHash} from 'node:crypto'

import {getAddress, type Hex, isAddress} from 'viem'
import {
  createSiweMessage,
  generateSiweNonce,
  parseSiweMessage,
  validateSiweMessage,
} from 'viem/siwe'

import {type AuditLog} from '../audit.ts'
import {type Config} from '../config.ts'
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  tooManyRequests,
  unprocessable,
} from '../errors.ts'
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
  | 'WALLET_CHALLENGES_PER_HOUR'
  | 'WALLET_RELINK_COOLDOWN_SECONDS'
>

export type RequestContext = {requestId?: string}

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

const HOUR_MS = 3_600_000

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
  private readonly audit: AuditLog | undefined
  private readonly now: Clock

  constructor(
    repo: WalletRepository,
    signatures: WalletSignatureVerifier,
    config: WalletLinkConfig,
    now: Clock = () => new Date(),
    audit?: AuditLog,
  ) {
    this.repo = repo
    this.signatures = signatures
    this.config = config
    this.now = now
    this.audit = audit
  }

  private async record(
    action: string,
    did: string,
    outcome: 'success' | 'denied' | 'failure',
    ctx: RequestContext | undefined,
    extra: {
      reason?: string
      subjectId?: string
      metadata?: Record<string, string | number | boolean | null>
    } = {},
  ) {
    await this.audit?.record({
      action,
      actorDid: did,
      subjectType: 'wallet',
      outcome,
      requestId: ctx?.requestId,
      ...extra,
    })
  }

  /** Runs `fn`; any AppError it throws is audited, then rethrown. */
  private async audited<T>(
    action: string,
    did: string,
    ctx: RequestContext | undefined,
    meta: Record<string, string | number | boolean | null>,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof AppError) {
        await this.record(
          action,
          did,
          e.statusCode >= 500 ? 'failure' : 'denied',
          ctx,
          {reason: e.code, metadata: meta},
        )
      }
      throw e
    }
  }

  async createChallenge(
    did: string,
    input: {address: string; chainId: number},
    ctx?: RequestContext,
  ) {
    const meta = {chainId: input.chainId}
    return this.audited('wallet.challenge.create', did, ctx, meta, async () => {
      if (!isAddress(input.address, {strict: false})) {
        throw badRequest('invalid_address', 'Invalid wallet address')
      }
      if (!this.config.ALLOWED_CHAIN_IDS.includes(input.chainId)) {
        throw unprocessable('unsupported_chain', 'This chain is not supported')
      }
      const address = input.address.toLowerCase()
      const issuedAt = this.now()

      // Quota enforced from the database so it holds across instances.
      const recent = await this.repo.countChallengesSince(
        did,
        new Date(issuedAt.getTime() - HOUR_MS),
      )
      if (recent >= this.config.WALLET_CHALLENGES_PER_HOUR) {
        throw tooManyRequests(300)
      }

      const existing = await this.repo.findLinkByAddress(input.chainId, address)
      if (existing) {
        throw conflict(
          existing.did === did ? 'already_linked' : 'wallet_already_linked',
          existing.did === did
            ? 'This wallet is already linked to your account'
            : 'This wallet is already linked to another account',
        )
      }
      // A wallet just released by another account cannot be claimed at once.
      const cooldownMs = this.config.WALLET_RELINK_COOLDOWN_SECONDS * 1000
      if (cooldownMs > 0) {
        const released = await this.repo.findRecentlyReleased(
          input.chainId,
          address,
          new Date(issuedAt.getTime() - cooldownMs),
        )
        if (released && released.did !== did) {
          throw conflict(
            'wallet_recently_released',
            'This wallet was recently unlinked from another account',
          )
        }
      }

      const nonce = generateSiweNonce()
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

      await this.record('wallet.challenge.create', did, 'success', ctx, {
        subjectId: challenge.id,
        metadata: meta,
      })
      return {
        challengeId: challenge.id,
        message: challenge.message,
        expiresAt: challenge.expiresAt.toISOString(),
      }
    })
  }

  async verifyChallenge(
    did: string,
    input: {challengeId: string; signature: Hex},
    ctx?: RequestContext,
  ): Promise<{wallet: PublicWallet; created: boolean}> {
    return this.audited(
      'wallet.link',
      did,
      ctx,
      {challengeId: input.challengeId},
      async () => {
        const now = this.now()

        /*
         * Single-use: the challenge is consumed by its own committed statement
         * BEFORE any signature work. It must not share a transaction with the
         * rest of this method, or a failed verification would roll the
         * consumption back and leave the challenge retryable. A failed attempt
         * needs a new challenge.
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

        let valid: boolean
        try {
          valid = await this.signatures.verify({
            address,
            message: challenge.message,
            signature: input.signature,
            chainId: challenge.chainId,
          })
        } catch (e) {
          // An infrastructure failure (for example the RPC being down) is not
          // a verdict on the signature, so the challenge is re-opened. A 4xx
          // such as an unsupported signature type stays consumed.
          if (e instanceof AppError && e.statusCode >= 500) {
            await this.repo.reopenChallenge(challenge.id)
          }
          throw e
        }
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
        if (created) {
          await this.record('wallet.link', did, 'success', ctx, {
            subjectId: wallet.id,
            metadata: {chainId: wallet.chainId},
          })
        }
        return {wallet: toPublicWallet(wallet), created}
      },
    )
  }

  async listWallets(did: string): Promise<PublicWallet[]> {
    return (await this.repo.listLinksForDid(did)).map(toPublicWallet)
  }

  /**
   * Unlinks a wallet. Authorised by the AT Protocol identity that owns the
   * link, so an account owner who lost the wallet can still remove it. The row
   * is revoked, not deleted, to keep history for audit and for the relink
   * cool-down. Refused while a payment involving the wallet is in flight.
   */
  async unlinkWallet(
    did: string,
    walletId: string,
    ctx?: RequestContext,
  ): Promise<PublicWallet> {
    return this.audited('wallet.unlink', did, ctx, {walletId}, async () => {
      const wallet = await this.repo.getLinkById(walletId)
      // Unknown, someone else's and already-unlinked look the same.
      if (!wallet || wallet.did !== did || wallet.revokedAt) {
        throw notFound('wallet_not_found', 'Wallet not found')
      }
      if (await this.repo.hasOpenPayments(wallet.chainId, wallet.address)) {
        throw conflict(
          'open_payments',
          'This wallet has payments in progress. Try again once they finish.',
        )
      }
      const revoked = await this.repo.revokeLink(walletId, did, this.now())
      if (!revoked) {
        throw notFound('wallet_not_found', 'Wallet not found')
      }
      await this.record('wallet.unlink', did, 'success', ctx, {
        subjectId: walletId,
        metadata: {chainId: revoked.chainId},
      })
      return toPublicWallet(revoked)
    })
  }
}
