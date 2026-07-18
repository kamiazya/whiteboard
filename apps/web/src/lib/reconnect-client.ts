// The wire contract is imported from its single definition
// (shared/api-contracts/reconnect.ts, exported through the package's
// api-contracts barrel) — the same module server/routes/reconnect.ts
// validates its responses with, so client and server cannot drift.
import {
  reconnectCredentialResponseSchema,
  reconnectSessionResponseSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import type { z } from 'zod'

const DEFAULT_TIMEOUT_MS = 10_000

export type EnrollResult =
  | { status: 'ok'; secret: string }
  | { status: 'rejected' }
  | { status: 'network-error' }
  | { status: 'invalid-response' }

export type RedeemResult =
  | { status: 'ok'; token: string; secret: string }
  | { status: 'rejected' }
  | { status: 'network-error' }
  | { status: 'invalid-response' }

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

// Shared failure shape for both endpoints: a 401/403 means the credential
// was rejected, anything else non-2xx / unparseable is an invalid response,
// and a thrown fetch is a network error.
type PostFailure =
  | { status: 'rejected' }
  | { status: 'network-error' }
  | { status: 'invalid-response' }
type PostOutcome<T> = { status: 'ok'; data: T } | PostFailure

async function postAndParse<T>(
  url: URL,
  headers: HeadersInit,
  schema: z.ZodType<T>,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<PostOutcome<T>> {
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'POST', headers, signal })
  } catch {
    return { status: 'network-error' }
  }

  if (res.status === 401 || res.status === 403) {
    return { status: 'rejected' }
  }
  if (!res.ok) {
    return { status: 'invalid-response' }
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { status: 'invalid-response' }
  }

  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    return { status: 'invalid-response' }
  }
  return { status: 'ok', data: parsed.data }
}

/**
 * POSTs /api/reconnect-credential to enroll `origin` for silent reconnect.
 * `daemonToken` is sent as `Authorization: Bearer` when present; omitted
 * entirely for a tokenless dev daemon (whose auth middleware treats an
 * absent header as authenticated — sending an empty Bearer would not).
 */
export async function enrollReconnectCredential(
  origin: string,
  daemonToken: string | null,
  fetchImpl: FetchLike,
  signal: AbortSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
): Promise<EnrollResult> {
  const url = new URL('/api/reconnect-credential', origin)
  const headers: HeadersInit = {}
  if (daemonToken) {
    headers.Authorization = `Bearer ${daemonToken}`
  }

  const outcome = await postAndParse(
    url,
    headers,
    reconnectCredentialResponseSchema,
    fetchImpl,
    signal,
  )
  if (outcome.status !== 'ok') return outcome
  return { status: 'ok', secret: outcome.data.reconnectSecret }
}

/**
 * POSTs /api/reconnect-session, presenting `secret` as
 * `Authorization: Bearer` (the secret travels the same way the daemon token
 * itself does — never in the body). On success the store's secret has
 * already been rotated server-side; the caller MUST persist the returned
 * `secret` to keep using the reconnect flow on a future load.
 */
export async function redeemReconnectSession(
  origin: string,
  secret: string,
  fetchImpl: FetchLike,
  signal: AbortSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
): Promise<RedeemResult> {
  const url = new URL('/api/reconnect-session', origin)
  const headers: HeadersInit = { Authorization: `Bearer ${secret}` }

  const outcome = await postAndParse(
    url,
    headers,
    reconnectSessionResponseSchema,
    fetchImpl,
    signal,
  )
  if (outcome.status !== 'ok') return outcome
  return { status: 'ok', token: outcome.data.token, secret: outcome.data.reconnectSecret }
}
