import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme, web} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonText} from '#/components/Button'
import {useDialogControl} from '#/components/Dialog'
import {Loader} from '#/components/Loader'
import * as Prompt from '#/components/Prompt'
import {Text} from '#/components/Typography'
import {Web3ApiError} from '#/features/web3/api/client'
import {
  useLinkedWalletsQuery,
  useUnlinkWalletMutation,
} from '#/features/web3/api/hooks'
import {type LinkedWallet} from '#/features/web3/api/types'
import {getNetworkName} from '#/features/web3/config'

function LinkedWalletRow({wallet}: {wallet: LinkedWallet}) {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const control = useDialogControl()
  const unlink = useUnlinkWalletMutation()
  const error = unlink.error

  return (
    <View
      style={[
        a.gap_sm,
        a.p_md,
        a.rounded_md,
        a.border,
        t.atoms.border_contrast_low,
      ]}
      testID={`linkedWallet-${wallet.id}`}>
      <Text
        selectable
        style={[a.text_md, a.font_semi_bold, web({wordBreak: 'break-all'})]}>
        {wallet.address}
      </Text>
      <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
        {getNetworkName(wallet.chainId)}
        {' · '}
        <Trans>
          Linked {i18n.date(new Date(wallet.verifiedAt), {dateStyle: 'medium'})}
        </Trans>
      </Text>
      {error && (
        <Admonition type="error">
          {error instanceof Web3ApiError && error.code === 'open_payments' ? (
            <Trans>
              This wallet has a payment in progress. Try again once it finishes.
            </Trans>
          ) : (
            <Trans>Could not unlink the wallet. Please try again.</Trans>
          )}
        </Admonition>
      )}
      <View style={[a.flex_row]}>
        <Button
          testID={`unlinkBtn-${wallet.id}`}
          label={l`Unlink wallet`}
          size="small"
          color="negative_subtle"
          disabled={unlink.isPending}
          onPress={() => control.open()}>
          <ButtonText>
            <Trans>Unlink</Trans>
          </ButtonText>
        </Button>
      </View>

      <Prompt.Basic
        control={control}
        title={l`Unlink this wallet?`}
        description={l`It will no longer be connected to your account. You will not be able to receive tips at this address until you link a wallet again.`}
        onConfirm={() => unlink.mutate(wallet.id)}
        confirmButtonCta={l`Unlink`}
        confirmButtonColor="negative"
      />
    </View>
  )
}

/**
 * Wallets the SERVER has verified as belonging to this account.
 */
export function LinkedWallets() {
  const t = useTheme()
  const {data, isPending, isError, refetch} = useLinkedWalletsQuery()

  return (
    <View style={[a.gap_md]} testID="linkedWallets">
      <Text style={[a.text_lg, a.font_semi_bold]}>
        <Trans>Linked wallets</Trans>
      </Text>
      {isPending && <Loader size="md" />}
      {isError && (
        <Admonition type="error">
          <Trans>Could not load your linked wallets.</Trans>
        </Admonition>
      )}
      {isError && (
        <Button
          label="Retry"
          size="small"
          color="secondary"
          onPress={() => void refetch()}>
          <ButtonText>
            <Trans>Retry</Trans>
          </ButtonText>
        </Button>
      )}
      {data && data.length === 0 && (
        <Text
          testID="noLinkedWallets"
          style={[a.text_md, t.atoms.text_contrast_medium]}>
          <Trans>No wallets are linked to your account yet.</Trans>
        </Text>
      )}
      {data?.map(w => (
        <LinkedWalletRow key={w.id} wallet={w} />
      ))}
    </View>
  )
}
