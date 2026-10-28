import {type Agent} from '@atproto/lex'

import {buildNsids, type Nsids} from '#/features/web3/api/nsids'
import {
  type LinkedWallet,
  type PreparedTransfer,
  type Tip,
  type TipRecipient,
  type WalletChallenge,
  type Web3ApiConfig,
} from '#/features/web3/api/types'

export type Web3ApiMode = 'proxy' | 'direct'

export type Web3ApiOptions = {
  /**
   * `proxy`: send the request to the user's PDS with an `atproto-proxy`
   * header; the PDS adds a short-lived service-auth token and forwards it.
   * No CORS and no extra credentials. Verified against a local PDS.
   * `direct`: ask the PDS for a fresh service-auth token per call and call the
   * service itself (needs CORS and `baseUrl`).
   */
  mode: Web3ApiMode
  /** The service's DID, used as the token audience / proxy target. */
  serviceDid: string
  /** Required for `direct` mode. */
  baseUrl?: string
  nsidPrefix: string
}

/** A failure reported by the service. Never contains secrets. */
export class Web3ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterSeconds: number | undefined

  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'Web3ApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type FetchLike = Pick<Agent, 'fetchHandler'>

type CallOptions = {
  method?: 'GET' | 'POST'
  query?: Record<string, string>
  body?: unknown
}

/**
 * Typed client for `web3-api`.
 *
 * Authentication is always the AT Protocol identity of the signed-in account.
 * No credential is stored by this module: in proxy mode the PDS attaches
 * auth; in direct mode a service-auth token (expires in about a minute, bound
 * to this service and this one method) is requested per call and discarded.
 */
export function createWeb3Api(
  agent: FetchLike,
  opts: Web3ApiOptions,
  fetchImpl: typeof fetch = fetch,
) {
  const nsids: Nsids = buildNsids(opts.nsidPrefix)

  async function parse<T>(res: Response): Promise<T> {
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // Non-JSON body (proxy error page, etc.); fall through to the status.
    }
    if (!res.ok) {
      const err = (json as {error?: unknown} | null)?.error
      // The PDS reports its own errors as {error: "Name", message}; the
      // service reports {error: {code, message}}. Handle both.
      const code =
        typeof err === 'string'
          ? err
          : ((err as {code?: string} | undefined)?.code ?? 'request_failed')
      const message =
        (typeof err === 'object' && err
          ? (err as {message?: string}).message
          : undefined) ??
        (json as {message?: string} | null)?.message ??
        `Request failed (${res.status})`
      const retry = Number(res.headers.get('retry-after'))
      throw new Web3ApiError(
        res.status,
        code,
        message,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      )
    }
    return json as T
  }

  async function serviceAuthToken(lxm: string): Promise<string> {
    const q = new URLSearchParams({aud: opts.serviceDid, lxm})
    const res = await agent.fetchHandler(
      `/xrpc/com.atproto.server.getServiceAuth?${q}`,
      {method: 'GET'},
    )
    return (await parse<{token: string}>(res)).token
  }

  async function call<T>(nsid: string, o: CallOptions = {}): Promise<T> {
    const method = o.method ?? 'GET'
    const qs = o.query ? `?${new URLSearchParams(o.query)}` : ''
    const headers: Record<string, string> = {}
    if (o.body !== undefined) headers['content-type'] = 'application/json'
    const init = {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    }

    if (opts.mode === 'proxy') {
      headers['atproto-proxy'] = `${opts.serviceDid}#web3_api`
      return parse<T>(await agent.fetchHandler(`/xrpc/${nsid}${qs}`, init))
    }

    if (!opts.baseUrl) throw new Error('web3 API baseUrl is not configured')
    headers['authorization'] = `Bearer ${await serviceAuthToken(nsid)}`
    return parse<T>(await fetchImpl(`${opts.baseUrl}/xrpc/${nsid}${qs}`, init))
  }

  return {
    nsids,
    getConfig: () => call<Web3ApiConfig>(nsids.configGet),

    createChallenge: (input: {address: string; chainId: number}) =>
      call<WalletChallenge>(nsids.walletCreateChallenge, {
        method: 'POST',
        body: input,
      }),
    verifyChallenge: (input: {challengeId: string; signature: string}) =>
      call<{wallet: LinkedWallet}>(nsids.walletVerifyChallenge, {
        method: 'POST',
        body: input,
      }),
    listWallets: () =>
      call<{wallets: LinkedWallet[]}>(nsids.walletList).then(r => r.wallets),
    unlinkWallet: (walletId: string) =>
      call<{wallet: LinkedWallet}>(nsids.walletUnlink, {
        method: 'POST',
        body: {walletId},
      }),

    getTipRecipient: (did: string, chainId: number) =>
      call<TipRecipient>(nsids.tipGetRecipient, {
        query: {did, chainId: String(chainId)},
      }),
    createTipIntent: (input: {
      recipientDid: string
      chainId: number
      amount: string
      senderAddress: string
      postUri?: string
      /** Retries with the same key create at most one payment. */
      idempotencyKey: string
    }) =>
      call<{tip: Tip; transfer: PreparedTransfer}>(nsids.tipCreateIntent, {
        method: 'POST',
        body: input,
      }),
    submitTipTransaction: (input: {intentId: string; txHash: string}) =>
      call<{tip: Tip}>(nsids.tipSubmitTransaction, {
        method: 'POST',
        body: input,
      }).then(r => r.tip),
    getTip: (id: string) =>
      call<{tip: Tip}>(nsids.tipGetIntent, {query: {id}}).then(r => r.tip),
    listTips: (role: 'sent' | 'received') =>
      call<{tips: Tip[]}>(nsids.tipListIntents, {query: {role}}).then(
        r => r.tips,
      ),
  }
}

export type Web3Api = ReturnType<typeof createWeb3Api>
