import {AtprotoServiceAuthVerifier} from './auth/atproto-service-auth.ts'
import {DevInsecureAuthVerifier} from './auth/dev-insecure.ts'
import {type AuthVerifier} from './auth/types.ts'
import {ConfigError, loadConfig} from './config.ts'
import {runMaintenance} from './db/maintenance.ts'
import {createPool} from './db/pool.ts'
import {startLoop} from './jobs.ts'
import {buildNsids} from './lexicon-ids.ts'
import {defaultRouteLimits} from './rate-limit.ts'
import {buildServer} from './server.ts'
import {createServices} from './services.ts'

async function main() {
  const config = loadConfig()
  const db = createPool(config)

  const auth: AuthVerifier =
    config.AUTH_MODE === 'dev-insecure'
      ? new DevInsecureAuthVerifier()
      : AtprotoServiceAuthVerifier.fromPlcUrl(
          config.SERVICE_DID,
          config.PLC_URL,
          {
            allowInsecurePlc: config.ALLOW_INSECURE_PLC,
          },
        )

  // Logs go through a late-bound reference so services can log before the HTTP
  // server (and its logger) exists.
  let logger: {
    info: (o: object, m: string) => void
    error: (o: object, m: string) => void
  } = {
    info: (o, m) => console.log(m, JSON.stringify(o)),
    error: (o, m) => console.error(m, o),
  }
  const log = (o: Record<string, unknown>, m: string) =>
    'err' in o ? logger.error(o, m) : logger.info(o, m)

  const services = await createServices(config, db, log)
  const app = await buildServer({
    config,
    db,
    auth,
    wallets: services.wallets,
    tips: services.tips,
    nsids: buildNsids(config.NSID_PREFIX),
    limits: defaultRouteLimits(config.RATE_LIMIT_PER_MINUTE),
  })
  logger = app.log
  if (config.AUTH_MODE === 'dev-insecure') {
    app.log.warn('AUTH_MODE=dev-insecure: requests are NOT authenticated')
  }

  const stops: (() => Promise<void>)[] = []
  if (config.RUN_WORKER) {
    if (services.reader) {
      stops.push(
        startLoop(
          'reconciler',
          config.RECONCILE_INTERVAL_MS,
          () => services.reconciler.runOnce(),
          log,
        ),
      )
    }
    stops.push(
      startLoop(
        'maintenance',
        config.CLEANUP_INTERVAL_MS,
        async () => {
          const r = await runMaintenance(db, new Date(), {
            auditRetentionDays: config.AUDIT_RETENTION_DAYS,
          })
          app.log.info(r, 'maintenance complete')
        },
        log,
      ),
    )
  }

  const shutdown = async (signal: string) => {
    app.log.info({signal}, 'shutting down')
    await Promise.all(stops.map(s => s()))
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
