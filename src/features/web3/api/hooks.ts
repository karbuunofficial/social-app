import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {createQueryKey} from '#/state/queries/util'
import {useMaybeSessionAgent, useSession} from '#/state/session'
import {createWeb3Api, type Web3Api} from '#/features/web3/api/client'
import {isWeb3ApiConfigured, WEB3_API} from '#/features/web3/config'

/**
 * The API client for the signed-in account, or null when logged out or when
 * the service is not configured. Cheap to create: it holds no state or
 * credentials.
 */
export function useWeb3Api(): Web3Api | null {
  const agent = useMaybeSessionAgent()
  if (!agent || !isWeb3ApiConfigured) return null
  return createWeb3Api(agent, WEB3_API)
}

export const web3ConfigQueryKeyRoot = 'useWeb3ConfigQuery'
export function useWeb3ConfigQuery() {
  const api = useWeb3Api()
  const {currentAccount} = useSession()
  return useQuery({
    enabled: !!api,
    staleTime: STALE.MINUTES.FIVE,
    queryKey: createQueryKey(web3ConfigQueryKeyRoot, {
      did: currentAccount?.did,
    }),
    queryFn: () => api!.getConfig(),
  })
}

export const linkedWalletsQueryKeyRoot = 'useLinkedWalletsQuery'
export function useLinkedWalletsQuery() {
  const api = useWeb3Api()
  const {currentAccount} = useSession()
  return useQuery({
    enabled: !!api,
    staleTime: STALE.SECONDS.FIFTEEN,
    queryKey: createQueryKey(linkedWalletsQueryKeyRoot, {
      did: currentAccount?.did,
    }),
    queryFn: () => api!.listWallets(),
  })
}

export function useInvalidateLinkedWallets() {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({queryKey: [linkedWalletsQueryKeyRoot]})
}

export function useUnlinkWalletMutation() {
  const api = useWeb3Api()
  const invalidate = useInvalidateLinkedWallets()
  return useMutation({
    mutationFn: (walletId: string) => api!.unlinkWallet(walletId),
    onSuccess: () => invalidate(),
  })
}

export const tipRecipientQueryKeyRoot = 'useTipRecipientQuery'
export function useTipRecipientQuery(args: {
  recipientDid: string
  chainId: number | undefined
  enabled: boolean
}) {
  const api = useWeb3Api()
  return useQuery({
    enabled: !!api && args.enabled && args.chainId !== undefined,
    staleTime: STALE.MINUTES.ONE,
    queryKey: createQueryKey(tipRecipientQueryKeyRoot, {
      did: args.recipientDid,
      chainId: args.chainId,
    }),
    queryFn: () => api!.getTipRecipient(args.recipientDid, args.chainId!),
  })
}
