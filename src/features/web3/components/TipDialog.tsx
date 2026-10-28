import {useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'
import {useNavigation} from '@react-navigation/native'
import {useQuery} from '@tanstack/react-query'

import {type NavigationProp} from '#/lib/routes/types'
import {useSession} from '#/state/session'
import {atoms as a, useTheme, web} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as TextField from '#/components/forms/TextField'
import {SimpleInlineLinkText} from '#/components/Link'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {
  useLinkedWalletsQuery,
  useTipRecipientQuery,
  useWeb3Api,
  useWeb3ConfigQuery,
} from '#/features/web3/api/hooks'
import {type Tip} from '#/features/web3/api/types'
import {WalletPanel} from '#/features/web3/components/WalletPanel'
import {getNetworkName, TARGET_NETWORK} from '#/features/web3/config'
import {parseUsdcAmount} from '#/features/web3/tip/amount'
import {describeTip, isFinalTip} from '#/features/web3/tip/describe'
import {
  newIdempotencyKey,
  payTip,
  submitSentTransaction,
  TipError,
  type TipFailure,
} from '#/features/web3/tip/payTip'
import {useWallet} from '#/features/web3/wallet/store'

export type TipRecipientInfo = {
  did: string
  handle: string
  displayName?: string
}

function failureText(reason: TipFailure) {
  switch (reason) {
    case 'wallet_rejected':
      return (
        <Trans>
          You declined the payment in your wallet. Nothing was sent.
        </Trans>
      )
    case 'wrong_network':
      return (
        <Trans>Your wallet is on the wrong network. Nothing was sent.</Trans>
      )
    case 'not_connected':
      return <Trans>Connect your wallet to continue. Nothing was sent.</Trans>
    case 'sender_wallet_not_linked':
      return (
        <Trans>
          Pay from a wallet that is linked to your account. Nothing was sent.
        </Trans>
      )
    case 'recipient_not_tippable':
      return (
        <Trans>
          This person can no longer receive tips here. Nothing was sent.
        </Trans>
      )
    case 'amount_invalid':
      return <Trans>That amount is not allowed. Nothing was sent.</Trans>
    case 'tipping_unavailable':
      return (
        <Trans>Tipping is not available right now. Nothing was sent.</Trans>
      )
    case 'rate_limited':
      return (
        <Trans>Too many tips in a short time. Please wait and try again.</Trans>
      )
    case 'unavailable':
      return <Trans>The service is unavailable. Please try again.</Trans>
    default:
      return <Trans>Something went wrong. Nothing was sent.</Trans>
  }
}

function amountProblemText(problem: string) {
  switch (problem) {
    case 'format':
      return <Trans>Enter a number such as 2 or 1.50.</Trans>
    case 'too_many_decimals':
      return <Trans>USDC has at most 6 decimal places.</Trans>
    case 'zero':
      return <Trans>The amount must be greater than zero.</Trans>
    case 'too_small':
      return <Trans>That is below the minimum tip.</Trans>
    case 'too_large':
      return <Trans>That is above the maximum tip.</Trans>
    default:
      return null
  }
}

/**
 * Follows a payment until the SERVICE reaches a final state. It polls the
 * service's record, which only changes when the service has read the chain. A
 * wallet saying "submitted" never shows up here as success.
 */
function TipStatus({tipId, initial}: {tipId: string; initial: Tip}) {
  const t = useTheme()
  const api = useWeb3Api()
  const {data, isError} = useQuery({
    queryKey: ['useTipStatusQuery', {tipId}],
    initialData: initial,
    enabled: !!api,
    queryFn: () => api!.getTip(tipId),
    refetchInterval: q =>
      q.state.data && isFinalTip(q.state.data) ? false : 4000,
  })
  const tip = data
  const view = describeTip(tip)
  const explorer = tip.transaction?.explorerUrl

  return (
    <View style={[a.gap_md]} testID={`tipStatus-${view.kind}`}>
      {view.kind === 'pending' && (
        <View style={[a.flex_row, a.align_center, a.gap_md]}>
          <Loader size="md" />
          <Text style={[a.text_md]}>
            <Trans>
              Waiting for the network to confirm your payment
              {view.confirmations
                ? ` (${view.confirmations}/${view.required})`
                : ''}
              …
            </Trans>
          </Text>
        </View>
      )}
      {view.kind === 'confirmed' && (
        <Admonition type="tip">
          <Trans>
            Payment confirmed on {getNetworkName(tip.chainId)}. {tip.amount}{' '}
            {tip.token.symbol} was received.
          </Trans>
        </Admonition>
      )}
      {view.kind === 'reorged' && (
        <Admonition type="warning">
          <Trans>
            The network re-organised and your payment is being re-checked. It is
            not confirmed right now.
          </Trans>
        </Admonition>
      )}
      {view.kind === 'failed' && (
        <Admonition type="error">
          <Trans>
            The transaction did not match this tip or failed, so it was not
            counted. Check the explorer for details.
          </Trans>
        </Admonition>
      )}
      {view.kind === 'expired' && (
        <Admonition type="warning">
          <Trans>This tip expired before a transaction was seen.</Trans>
        </Admonition>
      )}
      {view.kind === 'not_sent' && (
        <Admonition type="info">
          <Trans>No transaction has been recorded for this tip.</Trans>
        </Admonition>
      )}
      {isError && (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>Could not refresh the status. It may be out of date.</Trans>
        </Text>
      )}
      {explorer && (
        <SimpleInlineLinkText
          testID="tipExplorerLink"
          to={explorer}
          label="View transaction on the block explorer"
          style={[a.text_md]}>
          <Trans>View transaction on the block explorer</Trans>
        </SimpleInlineLinkText>
      )}
    </View>
  )
}

function DetailRow({
  label,
  value,
  testID,
}: {
  label: string
  value: string
  testID?: string
}) {
  const t = useTheme()
  return (
    <View style={[a.gap_2xs]}>
      <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>{label}</Text>
      <Text
        selectable
        testID={testID}
        style={[a.text_md, a.font_semi_bold, web({wordBreak: 'break-all'})]}>
        {value}
      </Text>
    </View>
  )
}

type Phase = 'edit' | 'review' | 'paying' | 'unreported' | 'tracking'

function TipDialogContent({
  control,
  recipient,
  postUri,
}: {
  control: Dialog.DialogControlProps
  recipient: TipRecipientInfo
  postUri?: string
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const navigation = useNavigation<NavigationProp>()
  const {currentAccount} = useSession()
  const wallet = useWallet()
  const api = useWeb3Api()
  const config = useWeb3ConfigQuery()
  const linked = useLinkedWalletsQuery()

  const network = config.data?.tipping.find(
    n => n.chainId === TARGET_NETWORK.chainId,
  )
  const recipientQuery = useTipRecipientQuery({
    recipientDid: recipient.did,
    chainId: network?.chainId,
    enabled: !!network,
  })

  const [amountText, setAmountText] = useState('')
  const [phase, setPhase] = useState<Phase>('edit')
  const [stage, setStage] = useState<
    'creating' | 'awaiting_wallet' | 'reporting'
  >('creating')
  const [failure, setFailure] = useState<TipFailure | null>(null)
  const [attemptKey, setAttemptKey] = useState<string | null>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const [unreported, setUnreported] = useState<{
    tipId: string
    txHash: string
  } | null>(null)

  const parsed = network
    ? parseUsdcAmount(amountText, {
        minUnits: BigInt(network.minUnits),
        maxUnits: BigInt(network.maxUnits),
      })
    : null

  const onWalletSettings = () =>
    control.close(() => {
      navigation.navigate('WalletSettings')
    })

  const ready =
    wallet.status === 'connected' &&
    !!network &&
    !!currentAccount &&
    recipientQuery.data?.tippable === true
  const senderWallet = linked.data?.find(
    w =>
      wallet.status === 'connected' &&
      w.chainId === wallet.chainId &&
      w.address.toLowerCase() === wallet.address.toLowerCase(),
  )

  const onConfirm = async () => {
    if (
      !api ||
      !parsed?.ok ||
      !senderWallet ||
      wallet.status !== 'connected' ||
      recipientQuery.data?.tippable !== true ||
      !network
    ) {
      return
    }
    // One key per attempt: retrying cannot create a second payment.
    let key = attemptKey
    if (!key) {
      try {
        key = newIdempotencyKey()
      } catch {
        setFailure('unavailable')
        return
      }
      setAttemptKey(key)
    }
    setFailure(null)
    setPhase('paying')
    try {
      const res = await payTip({
        api,
        wallet,
        input: {
          recipientDid: recipient.did,
          chainId: network.chainId,
          amount: parsed.text,
          senderAddress: senderWallet.address,
          postUri,
        },
        idempotencyKey: key,
        onStage: setStage,
      })
      setTip(res.tip)
      setPhase('tracking')
    } catch (e) {
      if (e instanceof TipError && e.txHash && e.tipId) {
        // The wallet DID send. Only reporting failed; never ask it to send again.
        setUnreported({tipId: e.tipId, txHash: e.txHash})
        setPhase('unreported')
        return
      }
      setFailure(e instanceof TipError ? e.reason : 'unknown')
      setPhase('review')
    }
  }

  const onRetryReport = async () => {
    if (!api || !unreported) return
    try {
      const reported = await submitSentTransaction(
        api,
        unreported.tipId,
        unreported.txHash,
      )
      setTip(reported)
      setPhase('tracking')
    } catch {
      setFailure('unavailable')
    }
  }

  return (
    <View style={[a.gap_md]} testID="tipDialog">
      <Text style={[a.text_xl, a.font_semi_bold]}>
        <Trans>Send a tip</Trans>
      </Text>

      <Admonition type="warning">
        <Trans>
          Test network only. This sends test USDC on {TARGET_NETWORK.name},
          which has no real value. Nothing is sent until you confirm in your
          wallet.
        </Trans>
      </Admonition>

      <Text style={[a.text_md]}>
        <Trans>
          To {recipient.displayName || recipient.handle} (@{recipient.handle})
        </Trans>
      </Text>

      {(config.isPending || recipientQuery.isPending) && !config.isError && (
        <Loader size="md" />
      )}
      {config.isError && (
        <Admonition type="error">
          <Trans>Could not reach the tipping service.</Trans>
        </Admonition>
      )}
      {config.data && !network && (
        <Admonition type="info">
          <Trans>
            Tipping is not available on {TARGET_NETWORK.name} right now.
          </Trans>
        </Admonition>
      )}
      {recipientQuery.data && !recipientQuery.data.tippable && (
        <Admonition type="info">
          <View testID="tipNotTippable">
            <Text>
              <Trans>
                This person has not linked a verified wallet, so they cannot
                receive tips yet.
              </Trans>
            </Text>
          </View>
        </Admonition>
      )}

      {network && recipientQuery.data?.tippable && phase === 'edit' && (
        <>
          {wallet.status !== 'connected' && <WalletPanel />}
          {wallet.status === 'connected' &&
            !senderWallet &&
            !linked.isPending && (
              <View style={[a.gap_md]} testID="tipWalletNotLinked">
                <Admonition type="warning">
                  <Trans>
                    This wallet is not linked to your account. Link it first so
                    your payment can be verified.
                  </Trans>
                </Admonition>
                <Button
                  label={l`Open wallet settings`}
                  size="large"
                  color="secondary"
                  onPress={onWalletSettings}>
                  <ButtonText>
                    <Trans>Open wallet settings</Trans>
                  </ButtonText>
                </Button>
              </View>
            )}
          {ready && senderWallet && (
            <View style={[a.gap_md]}>
              <View style={[a.gap_xs]}>
                <TextField.LabelText>
                  <Trans>Amount ({network.token.symbol})</Trans>
                </TextField.LabelText>
                <TextField.Root>
                  <TextField.Input
                    testID="tipAmountInput"
                    label={l`Amount in USDC`}
                    placeholder="0.00"
                    keyboardType="decimal-pad"
                    inputMode="decimal"
                    defaultValue={amountText}
                    onChangeText={setAmountText}
                  />
                </TextField.Root>
                <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
                  <Trans>
                    Minimum {network.minAmount}, maximum {network.maxAmount}{' '}
                    {network.token.symbol}.
                  </Trans>
                </Text>
                {amountText !== '' && parsed && !parsed.ok && (
                  <Text
                    testID="tipAmountProblem"
                    style={[a.text_sm, {color: t.palette.negative_500}]}>
                    {amountProblemText(parsed.problem)}
                  </Text>
                )}
              </View>
              <Button
                testID="tipReviewBtn"
                label={l`Review tip`}
                size="large"
                color="primary"
                disabled={!parsed?.ok}
                onPress={() => {
                  setFailure(null)
                  setPhase('review')
                }}>
                <ButtonText>
                  <Trans>Review</Trans>
                </ButtonText>
              </Button>
            </View>
          )}
        </>
      )}

      {phase === 'review' &&
        network &&
        recipientQuery.data?.tippable &&
        senderWallet &&
        parsed?.ok && (
          <View style={[a.gap_md]} testID="tipPreview">
            <Text style={[a.text_lg, a.font_semi_bold]}>
              <Trans>Review your tip</Trans>
            </Text>
            <DetailRow
              label={l`Amount`}
              testID="tipPreviewAmount"
              value={`${parsed.text} ${network.token.symbol}`}
            />
            <DetailRow
              label={l`Network`}
              testID="tipPreviewNetwork"
              value={`${network.name}${network.isTestnet ? ` (${l`testnet`})` : ''}`}
            />
            <DetailRow
              label={l`Token contract`}
              testID="tipPreviewToken"
              value={network.token.address}
            />
            <DetailRow
              label={l`From (your linked wallet)`}
              testID="tipPreviewFrom"
              value={senderWallet.address}
            />
            <DetailRow
              label={l`To (recipient's verified wallet)`}
              testID="tipPreviewTo"
              value={recipientQuery.data.recipientAddress}
            />
            {failure && (
              <Admonition type="error">{failureText(failure)}</Admonition>
            )}
            <View style={[a.flex_row, a.gap_md, a.flex_wrap]}>
              <Button
                testID="tipConfirmBtn"
                label={l`Confirm in wallet`}
                size="large"
                color="primary"
                onPress={() => void onConfirm()}>
                <ButtonText>
                  <Trans>Confirm in wallet</Trans>
                </ButtonText>
              </Button>
              <Button
                testID="tipEditBtn"
                label={l`Change amount`}
                size="large"
                color="secondary"
                onPress={() => setPhase('edit')}>
                <ButtonText>
                  <Trans>Change amount</Trans>
                </ButtonText>
              </Button>
            </View>
          </View>
        )}

      {phase === 'paying' && (
        <View
          style={[a.flex_row, a.align_center, a.gap_md]}
          testID={`tipPaying-${stage}`}>
          <Loader size="md" />
          <Text style={[a.text_md]}>
            {stage === 'creating' && <Trans>Preparing your tip…</Trans>}
            {stage === 'awaiting_wallet' && (
              <Trans>Confirm the payment in your wallet…</Trans>
            )}
            {stage === 'reporting' && (
              <Trans>Recording your transaction…</Trans>
            )}
          </Text>
        </View>
      )}

      {phase === 'unreported' && (
        <View style={[a.gap_md]} testID="tipUnreported">
          <Admonition type="warning">
            <Trans>
              Your wallet sent the transaction, but we could not record it yet.
              Do not pay again. Try recording it again.
            </Trans>
          </Admonition>
          {failure && (
            <Admonition type="error">{failureText(failure)}</Admonition>
          )}
          <Button
            testID="tipRetryReportBtn"
            label={l`Record transaction again`}
            size="large"
            color="primary"
            onPress={() => void onRetryReport()}>
            <ButtonText>
              <Trans>Record again</Trans>
            </ButtonText>
          </Button>
        </View>
      )}

      {phase === 'tracking' && tip && (
        <TipStatus tipId={tip.id} initial={tip} />
      )}

      {failure && phase === 'edit' && (
        <Admonition type="error">{failureText(failure)}</Admonition>
      )}
    </View>
  )
}

/**
 * Tip dialog. Nothing is sent until the user presses "Confirm in wallet" on the
 * review step and then approves in their own wallet. Payment status shown here
 * always comes from the service, which confirms it by reading the chain.
 */
export function TipDialog({
  control,
  recipient,
  postUri,
}: {
  control: Dialog.DialogControlProps
  recipient: TipRecipientInfo
  postUri?: string
}) {
  const {t: l} = useLingui()
  return (
    <Dialog.Outer control={control} nativeOptions={{preventExpansion: true}}>
      <Dialog.Handle />
      <Dialog.ScrollableInner
        label={l`Send a tip`}
        style={web({maxWidth: 480})}>
        <TipDialogContent
          control={control}
          recipient={recipient}
          postUri={postUri}
        />
        <Dialog.Close />
      </Dialog.ScrollableInner>
    </Dialog.Outer>
  )
}
