import {type FastifyInstance} from 'fastify'
import {z} from 'zod'

import {type AuthVerifier} from '../auth/types.ts'
import {type Nsids} from '../lexicon-ids.ts'
import {type RouteLimits} from '../rate-limit.ts'
import {type WalletLinkService} from './service.ts'

const createChallengeBody = z.strictObject({
  address: z.string().min(1).max(64),
  chainId: z.number().int().positive(),
})

const verifyChallengeBody = z.strictObject({
  challengeId: z.uuid(),
  // 65-byte EOA signatures are 132 hex chars; smart-wallet (ERC-1271/6492)
  // payloads are longer but bounded.
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .max(8192),
})

const unlinkBody = z.strictObject({walletId: z.uuid()})

export function registerWalletRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthVerifier
    wallets: WalletLinkService
    nsids: Nsids
    limits: RouteLimits
  },
) {
  const {nsids, limits} = deps
  const authenticate = (
    headers: Record<string, string | string[] | undefined>,
    lxm: string,
  ) => deps.auth.verify({headers, lxm})

  app.post(`/xrpc/${nsids.walletCreateChallenge}`, async req => {
    const user = await authenticate(req.headers, nsids.walletCreateChallenge)
    limits.createChallenge.consume(user.did)
    const body = createChallengeBody.parse(req.body)
    return deps.wallets.createChallenge(user.did, body, {requestId: req.id})
  })

  app.post(`/xrpc/${nsids.walletVerifyChallenge}`, async (req, reply) => {
    const user = await authenticate(req.headers, nsids.walletVerifyChallenge)
    limits.verifyChallenge.consume(user.did)
    const body = verifyChallengeBody.parse(req.body)
    const {wallet, created} = await deps.wallets.verifyChallenge(
      user.did,
      {
        challengeId: body.challengeId,
        signature: body.signature as `0x${string}`,
      },
      {requestId: req.id},
    )
    return reply.status(created ? 201 : 200).send({wallet})
  })

  app.get(`/xrpc/${nsids.walletList}`, async req => {
    const user = await authenticate(req.headers, nsids.walletList)
    limits.read.consume(user.did)
    return {wallets: await deps.wallets.listWallets(user.did)}
  })

  app.post(`/xrpc/${nsids.walletUnlink}`, async req => {
    const user = await authenticate(req.headers, nsids.walletUnlink)
    limits.unlink.consume(user.did)
    const body = unlinkBody.parse(req.body)
    return {
      wallet: await deps.wallets.unlinkWallet(user.did, body.walletId, {
        requestId: req.id,
      }),
    }
  })
}
