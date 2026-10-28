import {safeWalletIcon, type WalletOption} from '#/features/web3/wallet/types'

type ProviderInfo = {
  uuid?: unknown
  name?: unknown
  icon?: unknown
  rdns?: unknown
}
type AnnounceEvent = CustomEvent<{info?: ProviderInfo}>

/**
 * First-party EIP-6963 discovery. Wallets announce their own name and icon, so
 * the picker needs no thirdweb call and no request to any remote service.
 * Browser only.
 */
export async function discoverWallets(): Promise<WalletOption[]> {
  if (typeof window === 'undefined') return []
  const found = new Map<string, WalletOption>()

  const onAnnounce = (e: Event) => {
    const info = (e as AnnounceEvent).detail?.info
    if (
      !info ||
      typeof info.rdns !== 'string' ||
      typeof info.name !== 'string'
    ) {
      return
    }
    // Bounded, untrusted strings: cap what a page-injected wallet can show.
    found.set(info.rdns, {
      id: info.rdns.slice(0, 120),
      name: info.name.slice(0, 60),
      icon: safeWalletIcon(info.icon),
    })
  }

  window.addEventListener('eip6963:announceProvider', onAnnounce)
  try {
    // Wallets answer this synchronously by re-announcing themselves.
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    await new Promise(r => setTimeout(r, 50))
  } finally {
    window.removeEventListener('eip6963:announceProvider', onAnnounce)
  }
  return [...found.values()]
}
