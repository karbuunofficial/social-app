import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'

import {loadConfig} from '../../src/config.ts'
import {WalletLinkService} from '../../src/wallet/service.ts'
import {EoaSignatureVerifier} from '../../src/wallet/signature-verifier.ts'
import {MemoryWalletRepository} from './memory-wallet-repo.ts'

export const ALICE = 'did:plc:alice1234567890abcdefgh'
export const BOB = 'did:plc:bob1234567890abcdefghij'

export const baseEnv = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  WEB_APP_ORIGIN: 'http://localhost:19006',
  SERVICE_DID: 'did:web:localhost',
  ALLOWED_CHAIN_IDS: '84532',
  LOG_LEVEL: 'silent',
}

export const testConfig = () => loadConfig(baseEnv)

/** A throwaway account. The key exists only in memory for the test run. */
export const newWallet = () => privateKeyToAccount(generatePrivateKey())

export function makeService(now: () => Date = () => new Date()) {
  const repo = new MemoryWalletRepository()
  const service = new WalletLinkService(
    repo,
    new EoaSignatureVerifier(),
    testConfig(),
    now,
  )
  return {repo, service}
}
