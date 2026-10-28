import {describe, expect, it} from '@jest/globals'

import {buildNsids} from '#/features/web3/api/nsids'

describe('nsids', () => {
  /*
   * The SAME literal list is asserted in web3-api/test (nsids.test.ts). If a
   * method is renamed on one side, one of the two tests fails.
   */
  it('matches the backend method names', () => {
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
  })

  it('uses the configured prefix and never an app.bsky name', () => {
    const all = Object.values(buildNsids('org.example.web3'))
    expect(all.every(n => n.startsWith('org.example.web3.'))).toBe(true)
    expect(all.some(n => n.startsWith('app.bsky'))).toBe(false)
  })
})
