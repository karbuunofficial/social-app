import {Web3ApiError} from '#/features/web3/api/client'
import {
  type LinkedWallet,
  type WalletChallenge,
} from '#/features/web3/api/types'
import {WalletError} from '#/features/web3/wallet/types'

export type LinkStage =
  'requesting_challenge' | 'awaiting_signature' | 'verifying'

export type LinkFailure =
  | 'unsupported_wallet_type'
  | 'rejected'
  | 'wallet_taken'
  | 'already_linked'
  | 'recently_released'
  | 'challenge_expired'
  | 'invalid_signature'
  | 'unexpected_challenge'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown'

export class LinkError extends Error {
  readonly reason: LinkFailure

  constructor(reason: LinkFailure) {
    super(reason)
    this.name = 'LinkError'
    this.reason = reason
  }
}

/**
 * Refuses a challenge that is not exactly the sign-in the user asked for. The
 * wallet is about to sign whatever text the server returned, so this runs
 * first: even a compromised API cannot get a signature on a different address,
 * chain, account or website.
 *
 * Checks the EIP-4361 text for: this site's domain, the wallet's address (on
 * its own line), the chain id, and the signed-in account's DID.
 */
export function assertSafeChallenge(
  message: string,
  expected: {address: string; chainId: number; did: string; host: string},
): void {
  const lines = message.split('\n')
  const ok =
    lines[0] ===
      `${expected.host} wants you to sign in with your Ethereum account:` &&
    lines[1]?.toLowerCase() === expected.address.toLowerCase() &&
    lines.includes(`Chain ID: ${expected.chainId}`) &&
    lines.includes('Resources:') &&
    lines.includes(`- ${expected.did}`)
  if (!ok) throw new LinkError('unexpected_challenge')
}

function mapError(e: unknown): LinkError {
  if (e instanceof LinkError) return e
  if (e instanceof WalletError) {
    return new LinkError(e.reason === 'rejected' ? 'rejected' : 'unknown')
  }
  if (e instanceof Web3ApiError) {
    switch (e.code) {
      case 'unsupported_signature_type':
        return new LinkError('unsupported_wallet_type')
      case 'wallet_already_linked':
        return new LinkError('wallet_taken')
      case 'already_linked':
        return new LinkError('already_linked')
      case 'wallet_recently_released':
        return new LinkError('recently_released')
      case 'invalid_or_expired_challenge':
        return new LinkError('challenge_expired')
      case 'invalid_signature':
        return new LinkError('invalid_signature')
      case 'rate_limited':
        return new LinkError('rate_limited')
      case 'verification_unavailable':
        return new LinkError('unavailable')
    }
    if (e.status === 429) return new LinkError('rate_limited')
    if (e.status >= 500) return new LinkError('unavailable')
  }
  return new LinkError('unknown')
}

/**
 * Links a connected wallet to the signed-in account:
 * challenge -> the wallet signs -> the SERVER verifies.
 *
 * The wallet only counts as linked when the server says so. Nothing here can
 * mark a wallet linked on its own, and a connected wallet is never treated as
 * proof of ownership.
 */
export async function linkWallet(deps: {
  api: {
    createChallenge(i: {
      address: string
      chainId: number
    }): Promise<WalletChallenge>
    verifyChallenge(i: {
      challengeId: string
      signature: string
    }): Promise<{wallet: LinkedWallet}>
  }
  wallet: {signMessage(message: string): Promise<`0x${string}`>}
  address: string
  chainId: number
  /** The signed-in account's DID. */
  did: string
  /** The site the user is on; the challenge must be bound to it. */
  host: string
  onStage?: (stage: LinkStage) => void
  /** Called with the exact text the wallet is about to be asked to sign. */
  onChallenge?: (message: string) => void
}): Promise<LinkedWallet> {
  try {
    deps.onStage?.('requesting_challenge')
    const challenge = await deps.api.createChallenge({
      address: deps.address,
      chainId: deps.chainId,
    })
    assertSafeChallenge(challenge.message, {
      address: deps.address,
      chainId: deps.chainId,
      did: deps.did,
      host: deps.host,
    })
    deps.onChallenge?.(challenge.message)

    deps.onStage?.('awaiting_signature')
    const signature = await deps.wallet.signMessage(challenge.message)

    deps.onStage?.('verifying')
    const {wallet} = await deps.api.verifyChallenge({
      challengeId: challenge.challengeId,
      signature,
    })
    return wallet
  } catch (e) {
    throw mapError(e)
  }
}
