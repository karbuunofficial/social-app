/**
 * Method names served by `web3-api`. MUST match `web3-api/src/lexicon-ids.ts`
 * (`buildNsids`); `__tests__/nsids.test.ts` pins both to the same literals.
 *
 * The prefix is configuration (`EXPO_PUBLIC_WEB3_NSID_PREFIX`). The default is
 * a placeholder, not a namespace anyone owns: set a reverse-DNS name under a
 * domain the project controls before any public deployment. Never `app.bsky`.
 */
export const PLACEHOLDER_NSID_PREFIX = 'app.web3'

export function buildNsids(prefix: string) {
  return {
    walletCreateChallenge: `${prefix}.wallet.createChallenge`,
    walletVerifyChallenge: `${prefix}.wallet.verifyChallenge`,
    walletList: `${prefix}.wallet.listWallets`,
    walletUnlink: `${prefix}.wallet.unlinkWallet`,
    tipGetRecipient: `${prefix}.tip.getRecipient`,
    tipCreateIntent: `${prefix}.tip.createIntent`,
    tipSubmitTransaction: `${prefix}.tip.submitTransaction`,
    tipGetIntent: `${prefix}.tip.getIntent`,
    tipListIntents: `${prefix}.tip.listIntents`,
    configGet: `${prefix}.config.get`,
  } as const
}

export type Nsids = ReturnType<typeof buildNsids>
