import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme, web} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonText} from '#/components/Button'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {getNetworkName, TARGET_NETWORK} from '#/features/web3/config'
import {useWallet} from '#/features/web3/wallet/store'
import {type WalletFailureReason} from '#/features/web3/wallet/types'

function failureMessage(reason: WalletFailureReason) {
  switch (reason) {
    case 'not_configured':
      return <Trans>Wallet connection is not configured for this build.</Trans>
    case 'no_wallet_detected':
      return (
        <Trans>
          No browser wallet was detected. Install a wallet extension and try
          again.
        </Trans>
      )
    case 'rejected':
      return <Trans>The connection request was declined in your wallet.</Trans>
    case 'unsupported_platform':
      return (
        <Trans>
          Wallet connection is currently available on the web app only.
        </Trans>
      )
    default:
      return <Trans>Could not connect to the wallet. Please try again.</Trans>
  }
}

/**
 * Wallet connection panel. It only connects and disconnects a wallet. A
 * connected wallet is not linked to, or proven to belong to, the signed-in
 * social account.
 */
export function WalletPanel() {
  const t = useTheme()
  const {t: l} = useLingui()
  const wallet = useWallet()

  return (
    <View style={[a.gap_lg]} testID="walletPanel">
      <Admonition type="info">
        <Trans>
          Connecting a wallet does not link it to your account. Wallet linking
          requires a signed verification and is not available yet.
        </Trans>
      </Admonition>

      {wallet.status === 'disconnected' && (
        <View style={[a.gap_md]} testID="walletStateDisconnected">
          <Text style={[a.text_md, t.atoms.text_contrast_medium]}>
            <Trans>No wallet connected.</Trans>
          </Text>
          <Button
            testID="walletConnectBtn"
            label={l`Connect wallet`}
            size="large"
            color="primary"
            onPress={() => void wallet.connect()}>
            <ButtonText>
              <Trans>Connect wallet</Trans>
            </ButtonText>
          </Button>
        </View>
      )}

      {wallet.status === 'connecting' && (
        <View
          style={[a.flex_row, a.align_center, a.gap_md]}
          testID="walletStateConnecting">
          <Loader size="md" />
          <Text style={[a.text_md]}>
            <Trans>Check your wallet to approve the connection…</Trans>
          </Text>
        </View>
      )}

      {(wallet.status === 'connected' || wallet.status === 'wrong_network') && (
        <View
          style={[a.gap_md]}
          testID={
            wallet.status === 'connected'
              ? 'walletStateConnected'
              : 'walletStateWrongNetwork'
          }>
          {wallet.status === 'wrong_network' && (
            <Admonition type="warning">
              <Trans>
                Your wallet is on {getNetworkName(wallet.chainId)}. Switch to{' '}
                {TARGET_NETWORK.name} to continue.
              </Trans>
            </Admonition>
          )}
          <View style={[a.gap_xs]}>
            <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
              <Trans>Wallet address</Trans>
            </Text>
            {/*
             * The full address is shown on purpose. Truncated addresses make
             * look-alike ("address poisoning") substitutions hard to spot.
             */}
            <Text
              selectable
              testID="walletAddress"
              style={[
                a.text_md,
                a.font_semi_bold,
                web({wordBreak: 'break-all'}),
              ]}>
              {wallet.address}
            </Text>
          </View>
          <View style={[a.gap_xs]}>
            <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
              <Trans>Network</Trans>
            </Text>
            <Text testID="walletNetwork" style={[a.text_md, a.font_semi_bold]}>
              {getNetworkName(wallet.chainId)}
            </Text>
          </View>
          <View style={[a.flex_row, a.gap_md, a.flex_wrap]}>
            {wallet.status === 'wrong_network' && (
              <Button
                testID="walletSwitchBtn"
                label={l`Switch network`}
                size="large"
                color="primary"
                onPress={() => void wallet.switchNetwork()}>
                <ButtonText>
                  <Trans>Switch network</Trans>
                </ButtonText>
              </Button>
            )}
            <Button
              testID="walletDisconnectBtn"
              label={l`Disconnect wallet`}
              size="large"
              color="secondary"
              onPress={() => void wallet.disconnect()}>
              <ButtonText>
                <Trans>Disconnect</Trans>
              </ButtonText>
            </Button>
          </View>
        </View>
      )}

      {wallet.status === 'failed' && (
        <View style={[a.gap_md]} testID="walletStateFailed">
          <Admonition type="error">{failureMessage(wallet.reason)}</Admonition>
          {wallet.reason !== 'unsupported_platform' && (
            <Button
              testID="walletRetryBtn"
              label={l`Try again`}
              size="large"
              color="primary"
              onPress={() => void wallet.connect()}>
              <ButtonText>
                <Trans>Try again</Trans>
              </ButtonText>
            </Button>
          )}
        </View>
      )}
    </View>
  )
}
