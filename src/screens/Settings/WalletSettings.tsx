import {Trans} from '@lingui/react/macro'
import {type NativeStackScreenProps} from '@react-navigation/native-stack'

import {type CommonNavigatorParams} from '#/lib/routes/types'
import {NotFoundScreen} from '#/view/screens/NotFound'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {Admonition} from '#/components/Admonition'
import * as Layout from '#/components/Layout'
import {LinkedWallets} from '#/features/web3/components/LinkedWallets'
import {LinkWalletCard} from '#/features/web3/components/LinkWalletCard'
import {WalletPanel} from '#/features/web3/components/WalletPanel'
import {isWeb3ApiConfigured} from '#/features/web3/config'
import {useWeb3Flags} from '#/features/web3/flags'

type Props = NativeStackScreenProps<CommonNavigatorParams, 'WalletSettings'>
export function WalletSettingsScreen({}: Props) {
  const {walletConnectEnabled} = useWeb3Flags()

  /*
   * The route is always registered, so a direct URL must not expose the screen
   * while the flag is off.
   */
  if (!walletConnectEnabled) return <NotFoundScreen />

  return (
    <Layout.Screen testID="walletSettingsScreen">
      <Layout.Header.Outer>
        <Layout.Header.BackButton />
        <Layout.Header.Content>
          <Layout.Header.TitleText>
            <Trans>Wallet</Trans>
          </Layout.Header.TitleText>
        </Layout.Header.Content>
        <Layout.Header.Slot />
      </Layout.Header.Outer>
      <Layout.Content>
        <SettingsList.Container>
          <WalletPanel />
          {isWeb3ApiConfigured ? (
            <>
              <LinkWalletCard />
              <LinkedWallets />
            </>
          ) : (
            <Admonition type="info">
              <Trans>
                Wallet linking is not available: the Web3 service is not
                configured for this build.
              </Trans>
            </Admonition>
          )}
        </SettingsList.Container>
      </Layout.Content>
    </Layout.Screen>
  )
}
