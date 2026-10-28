import {type FastifyInstance} from 'fastify'
import {z} from 'zod'

import {type AuthVerifier} from '../auth/types.ts'
import {NSID} from '../lexicon-ids.ts'
import {type WalletLinkService} from './service.ts'

const createChallengeBody = z.strictObject({
  address: z.string().min(1).max(64),
  chainId: z.number().int().positive(),
})

const verifyChallengeBody = z.strictObject({
  challengeId: z.uuid(),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .max(8192),
})

export function registerWalletRoutes(
  app: FastifyInstance,
  deps: {auth: AuthVerifier; wallets: WalletLinkService},
) {
  const authenticate = (
    headers: Record<string, string | string[] | undefined>,
    lxm: string,
  ) => deps.auth.verify({headers, lxm})

  app.post(`/xrpc/${NSID.walletCreateChallenge}`, async req => {
    const user = await authenticate(req.headers, NSID.walletCreateChallenge)
    const body = createChallengeBody.parse(req.body)
    return deps.wallets.createChallenge(user.did, body)
  })

  app.post(`/xrpc/${NSID.walletVerifyChallenge}`, async (req, reply) => {
    const user = await authenticate(req.headers, NSID.walletVerifyChallenge)
    const body = verifyChallengeBody.parse(req.body)
    const {wallet, created} = await deps.wallets.verifyChallenge(user.did, {
      challengeId: body.challengeId,
      signature: body.signature as `0x${string}`,
    })
    return reply.status(created ? 201 : 200).send({wallet})
  })

  app.get(`/xrpc/${NSID.walletList}`, async req => {
    const user = await authenticate(req.headers, NSID.walletList)
    return {wallets: await deps.wallets.listWallets(user.did)}
  })
}
