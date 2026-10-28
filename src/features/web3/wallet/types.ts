/**
 * Why a wallet connection attempt failed. Kept as a closed set so the UI can
 * show translated copy instead of raw provider error messages.
 */
export type WalletFailureReason =
  | 'not_configured'
  | 'no_wallet_detected'
  | 'rejected'
  | 'unsupported_platform'
  | 'unknown'

export type WalletState =
  | {status: 'disconnected'}
  | {status: 'connecting'}
  | {status: 'connected'; address: string; chainId: number}
  | {
      status: 'wrong_network'
      address: string
      chainId: number
      expectedChainId: number
    }
  | {status: 'failed'; reason: WalletFailureReason}

/**
 * A connected wallet as reported by an adapter. A connected wallet is NOT proof
 * that it belongs to the signed-in AT Protocol account; that requires the
 * server-side challenge flow described in `web3-api/README.md`.
 */
export type WalletSnapshot = {address: string; chainId: number}

export class WalletError extends Error {
  reason: WalletFailureReason

  constructor(reason: WalletFailureReason) {
    super(reason)
    this.name = 'WalletError'
    this.reason = reason
  }
}

export type WalletAdapter = {
  /** False on platforms where no wallet integration exists yet. */
  isSupported: boolean
  /** Prompts the user to connect. Rejects with a {@link WalletError}. */
  connect(): Promise<WalletSnapshot>
  disconnect(): Promise<void>
  /** Asks the wallet to switch to the expected network. Sends no transaction. */
  switchNetwork(chainId: number): Promise<void>
  /**
   * Notifies when the wallet changes account or network, or disconnects
   * (`null`). Returns an unsubscribe function.
   */
  subscribe(listener: (snapshot: WalletSnapshot | null) => void): () => void
}

/**
 * Maps a wallet snapshot to the state the UI should show.
 */
export function deriveWalletState(
  snapshot: WalletSnapshot,
  expectedChainId: number,
): WalletState {
  if (snapshot.chainId !== expectedChainId) {
    return {
      status: 'wrong_network',
      address: snapshot.address,
      chainId: snapshot.chainId,
      expectedChainId,
    }
  }
  return {
    status: 'connected',
    address: snapshot.address,
    chainId: snapshot.chainId,
  }
}
