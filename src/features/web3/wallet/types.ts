/**
 * Why a wallet operation failed. Kept as a closed set so the UI can show
 * translated copy instead of raw provider error messages.
 */
export type WalletFailureReason =
  | 'not_configured'
  | 'no_wallet_detected'
  | 'rejected'
  | 'unsupported_platform'
  | 'not_connected'
  | 'wrong_network'
  | 'unknown'

/** A wallet the user can pick, as announced by the wallet itself (EIP-6963). */
export type WalletOption = {
  /** The wallet's reverse-DNS id, e.g. `io.metamask`. */
  id: string
  name: string
  /** A `data:image/...` URI, only if the wallet announced a safe one. */
  icon?: string
}

export type WalletState =
  | {status: 'disconnected'}
  /** More than one wallet is installed and the user has to pick one. */
  | {status: 'choosing'; options: WalletOption[]}
  | {status: 'connecting'}
  | {
      status: 'connected'
      address: string
      chainId: number
      walletName: string
    }
  | {
      status: 'wrong_network'
      address: string
      chainId: number
      expectedChainId: number
      walletName: string
    }
  | {status: 'failed'; reason: WalletFailureReason}

/**
 * A connected wallet as reported by an adapter. A connected wallet is NOT proof
 * that it belongs to the signed-in AT Protocol account; that requires the
 * server-side challenge flow (`web3-api/README.md`).
 */
export type WalletSnapshot = {
  address: string
  chainId: number
  walletName: string
}

export class WalletError extends Error {
  reason: WalletFailureReason

  constructor(reason: WalletFailureReason) {
    super(reason)
    this.name = 'WalletError'
    this.reason = reason
  }
}

/** An unsigned transaction request. The wallet decides whether to sign it. */
export type WalletTransaction = {
  chainId: number
  to: string
  data: string
  value: '0'
}

export type WalletAdapter = {
  /** False on platforms where no wallet integration exists yet. */
  isSupported: boolean
  /** Installed wallets. Never prompts and never contacts a remote service. */
  listWallets(): Promise<WalletOption[]>
  /** Prompts the user to connect. Rejects with a {@link WalletError}. */
  connect(walletId: string): Promise<WalletSnapshot>
  disconnect(): Promise<void>
  /** Asks the wallet to switch to the expected network. Sends no transaction. */
  switchNetwork(chainId: number): Promise<void>
  /** `personal_sign` with the connected wallet. Rejects with a WalletError. */
  signMessage(message: string): Promise<`0x${string}`>
  /**
   * Asks the connected wallet to sign and send. Resolves with the transaction
   * hash the wallet returns. That hash means "submitted", never "paid".
   */
  sendTransaction(tx: WalletTransaction): Promise<`0x${string}`>
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
      walletName: snapshot.walletName,
    }
  }
  return {
    status: 'connected',
    address: snapshot.address,
    chainId: snapshot.chainId,
    walletName: snapshot.walletName,
  }
}

/** Only `data:image/` URIs are rendered; anything else a wallet sends is dropped. */
export function safeWalletIcon(icon: unknown): string | undefined {
  return typeof icon === 'string' &&
    /^data:image\/(png|jpeg|webp|svg\+xml);/i.test(icon) &&
    icon.length < 100_000
    ? icon
    : undefined
}
