import {useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import {useDialogControl} from '#/components/Dialog'
import {Gift1_Stroke2_Corner0_Rounded as GiftIcon} from '#/components/icons/Gift1'
import {TipDialog} from '#/features/web3/components/TipDialog'
import {isWeb3ApiConfigured} from '#/features/web3/config'
import {useWeb3Flags} from '#/features/web3/flags'
import {type app} from '#/lexicons'

/**
 * Whether tipping UI should be offered at all: both flags on, the service
 * configured, and a signed-in account that is not the recipient.
 */
export function useCanOfferTip(recipientDid: string): boolean {
  const {tippingEnabled, walletConnectEnabled} = useWeb3Flags()
  const {currentAccount} = useSession()
  return (
    tippingEnabled &&
    walletConnectEnabled &&
    isWeb3ApiConfigured &&
    !!currentAccount &&
    currentAccount.did !== recipientDid
  )
}

/**
 * Profile header "Tip" button. Opens a dialog only; it never starts a payment.
 */
export function TipProfileButton({
  profile,
}: {
  profile: app.bsky.actor.defs.ProfileViewDetailed
}) {
  const {t: l} = useLingui()
  const control = useDialogControl()
  const canTip = useCanOfferTip(profile.did)
  if (!canTip) return null

  return (
    <>
      <Button
        testID="tipProfileBtn"
        size="small"
        color="secondary"
        label={l`Tip ${profile.handle}`}
        onPress={() => control.open()}>
        <ButtonIcon icon={GiftIcon} />
        <ButtonText>{l`Tip`}</ButtonText>
      </Button>
      <TipDialog
        control={control}
        recipient={{
          did: profile.did,
          handle: profile.handle,
          displayName: profile.displayName,
        }}
      />
    </>
  )
}
