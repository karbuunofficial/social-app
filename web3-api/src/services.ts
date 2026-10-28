import {type Pool} from 'pg'

import {PgAuditLog} from './audit.ts'
import {type ChainReader, ViemChainReader} from './chain/reader.ts'
import {type Config} from './config.ts'
import {PgIdempotencyStore} from './idempotency.ts'
import {buildChainConfigs} from './payments/chains.ts'
import {Reconciler, type ReconcilerOptions} from './payments/reconciler.ts'
import {PgTipRepository} from './payments/tip-repository.ts'
import {TippingService} from './payments/tipping-service.ts'
import {type VerifiedToken, verifyUsdcToken} from './payments/token-check.ts'
import {PgWalletRepository} from './wallet/pg-repository.ts'
import {WalletLinkService} from './wallet/service.ts'
import {
  EoaSignatureVerifier,
  SmartWalletAwareVerifier,
  type WalletSignatureVerifier,
} from './wallet/signature-verifier.ts'

type Log = (obj: Record<string, unknown>, msg: string) => void

export type Services = {
  wallets: WalletLinkService
  tips: TippingService
  reconciler: Reconciler
  reader: ChainReader | undefined
}

/**
 * Builds the service graph. Token verification happens here: if tipping is
 * configured for a chain and the token cannot be verified on chain, this
 * throws, so a misconfigured deployment refuses to start instead of running
 * against an unverified contract.
 */
export async function createServices(
  config: Config,
  db: Pool,
  log: Log,
  overrides: {
    reader?: ChainReader
    signatures?: WalletSignatureVerifier
    reconciler?: Partial<ReconcilerOptions>
  } = {},
): Promise<Services> {
  const audit = new PgAuditLog(db, log)
  const reader =
    overrides.reader ??
    (Object.keys(config.RPC_URLS).length > 0
      ? new ViemChainReader(config.RPC_URLS, config.RPC_TIMEOUT_MS)
      : undefined)

  const signatures: WalletSignatureVerifier =
    overrides.signatures ??
    (config.SMART_WALLET_SIGNATURES && reader instanceof ViemChainReader
      ? new SmartWalletAwareVerifier(reader, (chainId, p) =>
          reader.client(chainId).verifyMessage(p),
        )
      : new EoaSignatureVerifier())

  const walletRepo = new PgWalletRepository(db)
  const wallets = new WalletLinkService(
    walletRepo,
    signatures,
    config,
    undefined,
    audit,
  )

  const chains = buildChainConfigs({
    ALLOWED_CHAIN_IDS: config.ALLOWED_CHAIN_IDS,
    USDC_ADDRESSES: config.USDC_ADDRESSES,
  })

  const tokens = new Map<number, VerifiedToken>()
  for (const chainId of config.TIPPING_CHAIN_IDS) {
    const chain = chains.get(chainId)
    if (!chain || !reader)
      throw new Error(`tipping chain ${chainId} is not configured`)
    tokens.set(
      chainId,
      await verifyUsdcToken(reader, chain, {
        allowCustomAddress: config.ALLOW_CUSTOM_TOKEN_ADDRESS,
      }),
    )
    log(
      {chainId, token: tokens.get(chainId)!.address},
      'USDC token verified on chain',
    )
  }

  const tipRepo = new PgTipRepository(db)
  const tips = new TippingService({
    repo: tipRepo,
    wallets: walletRepo,
    chains,
    tokens,
    config,
    idempotency: new PgIdempotencyStore(db),
    audit,
  })
  const reconciler = new Reconciler({
    repo: tipRepo,
    reader: reader ?? ({} as ChainReader),
    chains,
    options: {
      pollIntervalMs: config.RECONCILE_INTERVAL_MS,
      batchSize: config.RECONCILE_BATCH_SIZE,
      ...overrides.reconciler,
    },
    audit,
    log,
  })
  return {wallets, tips, reconciler, reader}
}
