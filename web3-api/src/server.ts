import cors from '@fastify/cors'
import Fastify, {type FastifyInstance} from 'fastify'

import {type AuthVerifier} from './auth/types.ts'
import {type Config} from './config.ts'
import {type Db} from './db/pool.ts'
import {registerErrorHandler} from './errors.ts'
import {registerWalletRoutes} from './wallet/routes.ts'
import {type WalletLinkService} from './wallet/service.ts'

export type ServerDeps = {
  config: Pick<Config, 'LOG_LEVEL' | 'CORS_ALLOWED_ORIGINS' | 'NODE_ENV'>
  /** Used only for the readiness probe. */
  db: Pick<Db, 'query'>
  auth: AuthVerifier
  wallets: WalletLinkService
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      deps.config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: deps.config.LOG_LEVEL,
            // Structured JSON logs. Credentials and signatures never reach logs.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers["x-dev-did"]',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
          },
    bodyLimit: 16 * 1024,
    // Behind a proxy in production the real client address is needed for
    // logs; enable with explicit trust configuration when deploying.
    trustProxy: false,
  })

  registerErrorHandler(app)

  await app.register(cors, {
    // No wildcard: only explicitly configured origins are allowed.
    origin: deps.config.CORS_ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    allowedHeaders: ['authorization', 'content-type'],
  })

  // Liveness: the process is up. Touches nothing external.
  app.get('/health', () => ({status: 'ok'}))

  // Readiness: dependencies are reachable.
  app.get('/health/ready', async (_req, reply) => {
    try {
      await deps.db.query('SELECT 1')
      return {status: 'ready'}
    } catch {
      return reply.status(503).send({status: 'unavailable'})
    }
  })

  registerWalletRoutes(app, {auth: deps.auth, wallets: deps.wallets})

  return app
}
