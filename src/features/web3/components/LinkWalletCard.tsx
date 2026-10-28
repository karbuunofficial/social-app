import {useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import {atoms as a, useTheme, web} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonText} from '#/components/Button'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {
  useInvalidateLinkedWallets,
  useLinkedWalletsQuery,
  useWeb3Api,
} from '#/features/web3/api/hooks'
import {
  LinkError,
  type LinkFailure,
  type LinkStage,
  linkWallet,
} from '#/features/web3/link/linkFlow'
import {useWallet} from '#/features/web3/wallet/store'

function failureText(reason: LinkFailure) {
  switch (reason) {
    case 'unsupported_wallet_type':
      return (
        <Trans>
          This looks like a smart-contract wallet (for example a smart account),
          which cannot be linked yet. Use a standard wallet such as a browser
          extension account.
        </Trans>
      )
    case 'rejected':
      return (
        <Trans>You declined the signature request. Nothing was linked.</Trans>
      )
    case 'wallet_taken':
      return <Trans>This wallet is already linked to another account.</Trans>
    case 'already_linked':
      return <Trans>This wallet is already linked to your account.</Trans>
    case 'recently_released':
      return (
        <Trans>
          This wallet was recently unlinked from another account and cannot be
          linked yet. Try again later.
        </Trans>
      )
    case 'challenge_expired':
      return <Trans>The request expired. Please try again.</Trans>
    case 'invalid_signature':
      return (
        <Trans>The signature could not be verified. Please try again.</Trans>
      )
    case 'unexpected_challenge':
      return (
        <Trans>
          The verification request did not match this wallet, network or
          account, so it was not signed.
        </Trans>
      )
    case 'rate_limited':
      return (
        <Trans>Too many attempts. Please wait a moment and try again.</Trans>
      )
    case 'unavailable':
      return (
        <Trans>
          Verification is temporarily unavailable. Please try again.
        </Trans>
      )
    default:
      return <Trans>Something went wrong. Nothing was linked.</Trans>
  }
}

/**
 * Links the CONNECTED wallet to the signed-in account. Only the server's
 * answer can mark a wallet as linked, so what this card shows as linked always
 * comes from the linked-wallets list, never from a successful connection.
 */
export function LinkWalletCard() {
  const t = useTheme()
  const {t: l} = useLingui()
  const wallet = useWallet()
  const api = useWeb3Api()
  const {currentAccount} = useSession()
  const {data: linked} = useLinkedWalletsQuery()
  const invalidate = useInvalidateLinkedWallets()

  const [stage, setStage] = useState<LinkStage | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<LinkFailure | null>(null)
  const [done, setDone] = useState(false)

  if (wallet.status !== 'connected' && wallet.status !== 'wrong_network') {
    return null
  }
  if (!api || !currentAccount) return null

  const isLinked = linked?.some(
    w =>
      w.chainId === wallet.chainId &&
      w.address.toLowerCase() === wallet.address.toLowerCase(),
  )
  const busy = stage !== null

  const onLink = async () => {
    if (wallet.status !== 'connected') return
    setFailure(null)
    setDone(false)
    setMessage(null)
    try {
      await linkWallet({
        api,
        wallet,
        address: wallet.address,
        chainId: wallet.chainId,
        did: currentAccount.did,
        host: globalThis.location?.host ?? '',
        onStage: setStage,
        onChallenge: setMessage,
      })
      setDone(true)
      await invalidate()
    } catch (e) {
      setFailure(e instanceof LinkError ? e.reason : 'unknown')
    } finally {
      setStage(null)
    }
  }

  return (
    <View style={[a.gap_md]} testID="linkWalletCard">
      <Text style={[a.text_lg, a.font_semi_bold]}>
        <Trans>Link this wallet</Trans>
      </Text>

      {isLinked ? (
        <Admonition type="tip">
          <Trans>This wallet is linked to your account.</Trans>
        </Admonition>
      ) : wallet.status === 'wrong_network' ? (
        <Text style={[a.text_md, t.atoms.text_contrast_medium]}>
          <Trans>Switch to the right network to link this wallet.</Trans>
        </Text>
      ) : (
        <>
          <Text style={[a.text_md, t.atoms.text_contrast_medium]}>
            <Trans>
              You will be asked to sign a message. It does not send a
              transaction or give anyone access to your funds.
            </Trans>
          </Text>
          <Button
            testID="walletLinkBtn"
            label={l`Link this wallet to my account`}
            size="large"
            color="primary"
            disabled={busy}
            onPress={() => void onLink()}>
            <ButtonText>
              <Trans>Link this wallet</Trans>
            </ButtonText>
          </Button>
        </>
      )}

      {busy && (
        <View style={[a.flex_row, a.align_center, a.gap_md]} testID="linkStage">
          <Loader size="md" />
          <Text style={[a.text_md]}>
            {stage === 'requesting_challenge' && <Trans>Preparing…</Trans>}
            {stage === 'awaiting_signature' && (
              <Trans>Check your wallet to sign the message…</Trans>
            )}
            {stage === 'verifying' && <Trans>Verifying…</Trans>}
          </Text>
        </View>
      )}

      {/* The exact text being signed, so nothing is hidden from the user. */}
      {message && stage === 'awaiting_signature' && (
        <View style={[a.gap_xs]} testID="linkMessagePreview">
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>Message to sign</Trans>
          </Text>
          <Text
            selectable
            style={[
              a.text_sm,
              a.p_md,
              a.rounded_sm,
              t.atoms.bg_contrast_25,
              web({whiteSpace: 'pre-wrap', wordBreak: 'break-word'}),
            ]}>
            {message}
          </Text>
        </View>
      )}

      {done && !failure && (
        <View testID="linkSuccess">
          <Admonition type="tip">
            <Trans>Wallet linked. The server verified your signature.</Trans>
          </Admonition>
        </View>
      )}
      {failure && (
        <View testID={`linkFailed-${failure}`}>
          <Admonition type="error">{failureText(failure)}</Admonition>
        </View>
      )}
    </View>
  )
}
