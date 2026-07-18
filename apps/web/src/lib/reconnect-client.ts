import { z } from 'zod'

// Client-side mirrors of packages/mcp-server/src/server/routes/reconnect.ts's
// reconnectCredentialResponseSchema / reconnectSessionResponseSchema. Kept as
// manual copies, NOT a deep test-only import like daemon-probe's schema-drift
// pin: reconnect.ts lives under src/server/**, and
// web-app-boundary.test.ts's import-boundary guard forbids apps/web (even
// test files) from importing anything under src/server, src/cli, or
// src/daemon — only src/shared is reachable. Keep this file's two schemas
// byte-for-byte in sync with reconnect.ts's when either changes.
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

  const parsed = reconnectCredentialResponseSchema.safeParse(json)
  if (!parsed.success) {
    return { status: 'invalid-response' }
  }
  return { status: 'ok', secret: parsed.data.reconnectSecret }
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

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      signal,
    })
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

  const parsed = reconnectSessionResponseSchema.safeParse(json)
  if (!parsed.success) {
    return { status: 'invalid-response' }
  }
  return { status: 'ok', token: parsed.data.token, secret: parsed.data.reconnectSecret }
}
