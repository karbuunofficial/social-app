import {type FastifyInstance} from 'fastify'
import {z} from 'zod'

import {type AuthVerifier} from '../auth/types.ts'
import {type Config} from '../config.ts'
import {type Nsids} from '../lexicon-ids.ts'
import {type RouteLimits} from '../rate-limit.ts'
import {formatTokenAmount} from './amounts.ts'
import {type TippingService} from './tipping-service.ts'

const did = z
  .string()
  .regex(/^did:(web|plc):[a-zA-Z0-9._:%-]+$/)
  .max(2048)
const chainId = z.coerce.number().int().positive()

const createIntentBody = z.strictObject({
  recipientDid: did,
  chainId: z.number().int().positive(),
  amount: z.string().min(1).max(40),
  senderAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  postUri: z.string().max(512).optional(),
  /**
   * The key may also be sent as an `Idempotency-Key` header. It is accepted in
   * the body too because a PDS proxy forwards only some headers.
   */
  idempotencyKey: z.string().optional(),
})

const submitBody = z.strictObject({
  intentId: z.uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
})

export function registerTipRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthVerifier
    tips: TippingService
    nsids: Nsids
    limits: RouteLimits
  },
) {
  const {nsids, limits, tips} = deps
  const authenticate = (
    headers: Record<string, string | string[] | undefined>,
    lxm: string,
  ) => deps.auth.verify({headers, lxm})

  app.get(`/xrpc/${nsids.tipGetRecipient}`, async req => {
    const user = await authenticate(req.headers, nsids.tipGetRecipient)
    limits.read.consume(user.did)
    const q = z.strictObject({did, chainId}).parse(req.query)
    return tips.getRecipient(q.did, q.chainId)
  })

  app.post(`/xrpc/${nsids.tipCreateIntent}`, async (req, reply) => {
    const user = await authenticate(req.headers, nsids.tipCreateIntent)
    limits.tipIntent.consume(user.did)
    const {idempotencyKey, ...body} = createIntentBody.parse(req.body)
    const header = req.headers['idempotency-key']
    const key = idempotencyKey ?? (Array.isArray(header) ? header[0] : header)
    const res = await tips.createIntent(user.did, body, key, {
      requestId: req.id,
    })
    if (res.replayed) reply.header('idempotent-replayed', 'true')
    return reply.status(res.replayed ? 200 : res.status).send(res.body)
  })

  app.post(`/xrpc/${nsids.tipSubmitTransaction}`, async req => {
    const user = await authenticate(req.headers, nsids.tipSubmitTransaction)
    limits.tipSubmit.consume(user.did)
    const body = submitBody.parse(req.body)
    return {
      tip: await tips.submitTransaction(user.did, body, {requestId: req.id}),
    }
  })

  app.get(`/xrpc/${nsids.tipGetIntent}`, async req => {
    const user = await authenticate(req.headers, nsids.tipGetIntent)
    limits.read.consume(user.did)
    const q = z.strictObject({id: z.string().max(64)}).parse(req.query)
    return {tip: await tips.getIntent(user.did, q.id)}
  })

  app.get(`/xrpc/${nsids.tipListIntents}`, async req => {
    const user = await authenticate(req.headers, nsids.tipListIntents)
    limits.read.consume(user.did)
    const q = z
      .strictObject({role: z.enum(['sent', 'received']).default('sent')})
      .parse(req.query)
    return {tips: await tips.listIntents(user.did, q.role)}
  })
}

/** Public, non-sensitive description of what this deployment supports. */
export function registerConfigRoute(
  app: FastifyInstance,
  deps: {
    nsids: Nsids
    tips: TippingService
    config: Pick<
      Config,
      | 'ALLOWED_CHAIN_IDS'
      | 'SMART_WALLET_SIGNATURES'
      | 'TIP_MIN_UNITS'
      | 'TIP_MAX_UNITS'
    >
    limits: RouteLimits
  },
) {
  app.get(`/xrpc/${deps.nsids.configGet}`, req => {
    deps.limits.global.consume(`cfg:${req.ip}`)
    return {
      allowedChainIds: deps.config.ALLOWED_CHAIN_IDS,
      smartWalletSignatures: deps.config.SMART_WALLET_SIGNATURES,
      tipping: deps.tips.enabledChains().map(({chain, token}) => ({
        chainId: chain.chainId,
        name: chain.name,
        isTestnet: chain.isTestnet,
        explorerUrl: chain.explorerUrl,
        requiredConfirmations: chain.requiredConfirmations,
        token: {
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
        },
        minUnits: deps.config.TIP_MIN_UNITS.toString(),
        maxUnits: deps.config.TIP_MAX_UNITS.toString(),
        minAmount: formatTokenAmount(deps.config.TIP_MIN_UNITS, token.decimals),
        maxAmount: formatTokenAmount(deps.config.TIP_MAX_UNITS, token.decimals),
      })),
    }
  })
}
