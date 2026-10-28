import {AtprotoServiceAuthVerifier} from './auth/atproto-service-auth.ts'
import {DevInsecureAuthVerifier} from './auth/dev-insecure.ts'
import {type AuthVerifier} from './auth/types.ts'
import {ConfigError, loadConfig} from './config.ts'
import {createPool} from './db/pool.ts'
import {buildServer} from './server.ts'
import {PgWalletRepository} from './wallet/pg-repository.ts'
import {WalletLinkService} from './wallet/service.ts'
import {EoaSignatureVerifier} from './wallet/signature-verifier.ts'

async function main() {
  const config = loadConfig()
  const db = createPool(config)

  const auth: AuthVerifier =
    config.AUTH_MODE === 'dev-insecure'
      ? new DevInsecureAuthVerifier()
      : AtprotoServiceAuthVerifier.fromPlcUrl(
          config.SERVICE_DID,
          config.PLC_URL,
          {allowInsecurePlc: config.ALLOW_INSECURE_PLC},
        )

  const wallets = new WalletLinkService(
    new PgWalletRepository(db),
    new EoaSignatureVerifier(),
    config,
  )

  const app = await buildServer({config, db, auth, wallets})
  if (config.AUTH_MODE === 'dev-insecure') {
    app.log.warn('AUTH_MODE=dev-insecure: requests are NOT authenticated')
  }

  const shutdown = async (signal: string) => {
    app.log.info({signal}, 'shutting down')
    await app.close()
    await db.end()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({host: config.HOST, port: config.PORT})
}

main().catch(e => {
  if (e instanceof ConfigError) {
    console.error(e.message)
  } else {
    console.error('fatal startup error', e)
  }
  process.exit(1)
})
