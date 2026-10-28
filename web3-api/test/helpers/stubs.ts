import {MemoryIdempotencyStore} from '../../src/idempotency.ts'
import {type ChainConfig} from '../../src/payments/chains.ts'
import {type TipRepository} from '../../src/payments/tip-types.ts'
import {TippingService} from '../../src/payments/tipping-service.ts'
import {type VerifiedToken} from '../../src/payments/token-check.ts'
import {type WalletRepository} from '../../src/wallet/types.ts'
import {testConfig} from './fixtures.ts'

/** A TipRepository that fails loudly if a test unexpectedly touches it. */
export function untouchableTipRepo(): TipRepository {
  return new Proxy({} as TipRepository, {
    get: (_t, prop) => () => {
      throw new Error(`TipRepository.${String(prop)} should not be called`)
    },
  })
}

/** TippingService with no verified token: every chain reports "unavailable". */
export function tippingDisabled(wallets: WalletRepository) {
  return new TippingService({
    repo: untouchableTipRepo(),
    wallets,
    chains: new Map<number, ChainConfig>(),
    tokens: new Map<number, VerifiedToken>(),
    config: testConfig(),
    idempotency: new MemoryIdempotencyStore(),
  })
}
