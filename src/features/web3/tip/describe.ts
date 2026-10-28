import {type Tip} from '#/features/web3/api/types'

export type TipView =
  | {
      kind: 'pending'
      confirmations: string | null
      required: number
      submittedOnly: false
    }
  | {kind: 'confirmed'; blockNumber: string | null}
  | {kind: 'failed'}
  | {kind: 'expired'}
  | {kind: 'reorged'}
  | {kind: 'not_sent'}

/**
 * What to show for a payment, derived ONLY from the service's record of it.
 *
 * "Confirmed" requires the service to have read the chain and found the exact
 * transfer. A wallet reporting that it submitted a transaction is `pending` at
 * most, and an intent with no transaction is `not_sent`, never "paid".
 */
export function describeTip(tip: Tip): TipView {
  switch (tip.status) {
    case 'confirmed':
      return {
        kind: 'confirmed',
        blockNumber: tip.transaction?.blockNumber ?? null,
      }
    case 'failed':
      return {kind: 'failed'}
    case 'expired':
      return {kind: 'expired'}
    case 'reorged':
      return {kind: 'reorged'}
    case 'awaiting_confirmation':
      return {
        kind: 'pending',
        confirmations: tip.transaction?.confirmations ?? null,
        required: tip.requiredConfirmations,
        submittedOnly: false,
      }
    default:
      return {kind: 'not_sent'}
  }
}

/** Statuses after which the service will not change its mind. */
export function isFinalTip(tip: Tip): boolean {
  return (
    tip.status === 'confirmed' ||
    tip.status === 'failed' ||
    tip.status === 'expired'
  )
}
