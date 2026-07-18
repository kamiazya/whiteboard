import { z } from 'zod'

// Client-side mirrors of
// packages/mcp-server/src/shared/api-contracts/reconnect.ts's
// reconnectCredentialResponseSchema / reconnectSessionResponseSchema (that
// module is the server's single source of truth — server/routes/reconnect.ts
// imports it too). Kept as manual copies here rather than a build-time
// import: that module stays off the published npm barrel (see its own
// comment), so reaching into mcp-server internals at build time would be a
// fragile, undocumented coupling for a separately-deployed app. A dedicated
// reconnect-client.schema-drift.test.ts test-only deep-imports it to pin
// this mirror against field-level drift — keep this file's two schemas
// byte-for-byte in sync with the shared source when either changes.
export const reconnectCredentialResponseSchema = z.object({
  reconnectSecret: z.string().min(1),
  expiresInDays: z.number().positive(),
})
export type ReconnectCredentialResponse = z.infer<typeof reconnectCredentialResponseSchema>

export const reconnectSessionResponseSchema = z.object({
  // Not `.min(1)`: a tokenless local daemon legally returns '' here (see the
  // server schema's own comment) — the reconnect surface must accept that
  // the same way every other /api/* route treats a no-op auth configuration.
  token: z.string(),
  reconnectSecret: z.string().min(1),
  expiresInDays: z.number().positive(),
})
export type ReconnectSessionResponse = z.infer<typeof reconnectSessionResponseSchema>

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
