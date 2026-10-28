import cors from '@fastify/cors'
import Fastify, {type FastifyInstance} from 'fastify'

import {type AuthVerifier} from './auth/types.ts'
import {type Config} from './config.ts'
import {type Db} from './db/pool.ts'
import {registerErrorHandler} from './errors.ts'
import {type Nsids} from './lexicon-ids.ts'
import {registerConfigRoute, registerTipRoutes} from './payments/routes.ts'
import {type TippingService} from './payments/tipping-service.ts'
import {type RouteLimits} from './rate-limit.ts'
import {registerWalletRoutes} from './wallet/routes.ts'
import {type WalletLinkService} from './wallet/service.ts'

export type ServerDeps = {
  config: Pick<
    Config,
    | 'LOG_LEVEL'
    | 'CORS_ALLOWED_ORIGINS'
    | 'NODE_ENV'
    | 'TRUST_PROXY'
    | 'ALLOWED_CHAIN_IDS'
    | 'SMART_WALLET_SIGNATURES'
    | 'TIP_MIN_UNITS'
    | 'TIP_MAX_UNITS'
  > &
    Partial<Pick<Config, 'SERVICE_DID' | 'SERVICE_PUBLIC_URL'>>
  /** Used only for the readiness probe. */
  db: Pick<Db, 'query'>
  auth: AuthVerifier
  wallets: WalletLinkService
  tips: TippingService
  nsids: Nsids
  limits: RouteLimits
}

/**
 * Headers for a JSON API that is never meant to be rendered or framed.
 * `default-src 'none'` means that even if a response were ever interpreted as
 * a document it could load nothing and run no script.
 */
const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const production = deps.config.NODE_ENV === 'production'
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
    // Only trust X-Forwarded-For when explicitly told a trusted proxy fronts us.
    trustProxy:
      deps.config.TRUST_PROXY > 0
        ? // Trust exactly this many hops from the socket, never the whole header.
          (_addr: string, hop: number) => hop < deps.config.TRUST_PROXY
        : false,
  })

  registerErrorHandler(app)

  await app.register(cors, {
    // No wildcard: only explicitly configured origins are allowed.
    origin: deps.config.CORS_ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
    exposedHeaders: ['retry-after', 'idempotent-replayed'],
    maxAge: 600,
  })

  // Coarse outer guard. Per-DID limits inside the routes are the real limits:
  // behind a PDS proxy every user of that PDS shares one source address.
  app.addHook('onRequest', (req, _reply, done) => {
    try {
      deps.limits.global.consume(`ip:${req.ip}`)
      done()
    } catch (e) {
      done(e as Error)
    }
  })

  app.addHook('onSend', (req, reply, payload, done) => {
    reply.header('content-security-policy', API_CSP)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('cross-origin-opener-policy', 'same-origin')
    if (production) {
      reply.header(
        'strict-transport-security',
        'max-age=31536000; includeSubDomains',
      )
    }
    // API responses carry per-user data; the DID document is public.
    if (!reply.hasHeader('cache-control')) {
      reply.header(
        'cache-control',
        req.url.startsWith('/.well-known/')
          ? 'public, max-age=300'
          : 'no-store',
      )
    }
    done(null, payload)
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

  registerWalletRoutes(app, {
    auth: deps.auth,
    wallets: deps.wallets,
    nsids: deps.nsids,
    limits: deps.limits,
  })
  registerTipRoutes(app, {
    auth: deps.auth,
    tips: deps.tips,
    nsids: deps.nsids,
    limits: deps.limits,
  })
  registerConfigRoute(app, {
    nsids: deps.nsids,
    tips: deps.tips,
    config: deps.config,
    limits: deps.limits,
  })

  // did:web DID document, so a user's PDS can proxy requests to this service
  // (`atproto-proxy: <SERVICE_DID>#web3_api`). Only served for did:web DIDs.
  const {SERVICE_DID, SERVICE_PUBLIC_URL} = deps.config
  if (SERVICE_DID?.startsWith('did:web:') && SERVICE_PUBLIC_URL) {
    app.get('/.well-known/did.json', () => ({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: SERVICE_DID,
      service: [
        {
          id: '#web3_api',
          type: 'Web3Api',
          serviceEndpoint: SERVICE_PUBLIC_URL,
        },
      ],
    }))
  }

  return app
}
