import {describe, expect, it} from 'vitest'

import {buildNsids, NSID} from '../src/lexicon-ids.ts'

describe('nsids', () => {
  // The same literal list is asserted in the app's
  // src/features/web3/api/__tests__/nsids.test.ts.
  it('matches the app method names', () => {
    expect(Object.values(buildNsids('app.web3')).sort()).toEqual([
      'app.web3.config.get',
      'app.web3.tip.createIntent',
      'app.web3.tip.getIntent',
      'app.web3.tip.getRecipient',
      'app.web3.tip.listIntents',
      'app.web3.tip.submitTransaction',
      'app.web3.wallet.createChallenge',
      'app.web3.wallet.listWallets',
      'app.web3.wallet.unlinkWallet',
      'app.web3.wallet.verifyChallenge',
    ])
    expect(NSID.walletList).toBe('app.web3.wallet.listWallets')
  })
})
