// The wire contract is imported from its single definition
// (shared/api-contracts/reconnect.ts, exported through the package's
// api-contracts barrel) — the same module server/routes/reconnect.ts
// validates its responses with, so client and server cannot drift.
import {
  type EcP256PublicJwk,
  reconnectChallengeResponseSchema,
  reconnectCredentialResponseSchema,
  reconnectSessionResponseSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import { z } from 'zod'

const DEFAULT_TIMEOUT_MS = 10_000

// A pre-migration daemon's /api/reconnect-credential response: no
// `credentialKind` discriminant, because that daemon never learned the
// keypair contract. A new client detects this shape (rather than treating it
// as `invalid-response`) so it can still fall back to the legacy Bearer
// secret flow against an old daemon instead of losing silent reconnect
// entirely during a rollout.
const legacyCredentialResponseSchema = z.object({
  reconnectSecret: z.string().min(1),
  expiresInDays: z.number().positive(),
})

// A pre-migration daemon's /api/reconnect-session response also rotates the
// presented legacy secret on every successful redemption and echoes the
// replacement as `reconnectSecret` (the current contract's
// reconnectSessionResponseSchema declares only `token` and has no
// `.strict()`, so it would parse such a response successfully while
// silently dropping this field). Detected opportunistically alongside the
// canonical parse so the caller can persist the rotated secret instead of
// continuing to present one the daemon just invalidated.
const legacySessionRotationSchema = z.object({
  reconnectSecret: z.string().min(1),
})

export type EnrollResult =
  | { status: 'ok'; expiresInDays: number }
  | { status: 'legacy'; secret: string }
  | { status: 'rejected' }
  | { status: 'network-error' }
  | { status: 'invalid-response' }

export type ChallengeResult =
  | { status: 'ok'; challengeId: string; nonce: string }
  | { status: 'rejected' }
  | { status: 'network-error' }
  | { status: 'invalid-response' }

export type RedeemResult =
  | { status: 'ok'; token: string; rotatedSecret?: string }
  | { status: 'rejected' }
  | { status: 'network-error' }
  | { status: 'invalid-response' }

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

type PostOutcome =
  | { status: 'ok'; json: unknown }
  | { status: 'rejected' }
  | { status: 'network-error' }
  | { status: 'http-error'; json: unknown }

async function postJson(
  url: URL,
  headers: HeadersInit,
  body: unknown,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<PostOutcome> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch {
    return { status: 'network-error' }
  }

  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    json = null
  }

  if (res.status === 401 || res.status === 403) {
    return { status: 'rejected' }
  }
  if (!res.ok) {
    return { status: 'http-error', json }
  }
  return { status: 'ok', json }
}

/**
 * POSTs /api/reconnect-credential to enroll `origin`'s public key for silent
 * reconnect. `daemonToken` is sent as `Authorization: Bearer` when present;
 * omitted entirely for a tokenless dev daemon (whose auth middleware treats
 * an absent header as authenticated — sending an empty Bearer would not).
 *
 * `status: 'legacy'` signals a pre-migration daemon that ignored the sent
 * public key and returned a plaintext reconnect secret instead — the caller
 * persists that secret and falls back to the legacy Bearer-secret flow.
 */
export async function enrollReconnectCredential(
  origin: string,
  daemonToken: string | null,
  publicKeyJwk: EcP256PublicJwk,
  fetchImpl: FetchLike,
  signal: AbortSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
): Promise<EnrollResult> {
  const url = new URL('/api/reconnect-credential', origin)
  const headers: HeadersInit = { 'content-type': 'application/json' }
  if (daemonToken) {
    headers.Authorization = `Bearer ${daemonToken}`
  }

  const outcome = await postJson(url, headers, { publicKeyJwk }, fetchImpl, signal)
  if (outcome.status === 'network-error') return { status: 'network-error' }
  if (outcome.status === 'rejected') return { status: 'rejected' }
  if (outcome.status === 'http-error') return { status: 'invalid-response' }

  const parsed = reconnectCredentialResponseSchema.safeParse(outcome.json)
  if (parsed.success) return { status: 'ok', expiresInDays: parsed.data.expiresInDays }

  const legacy = legacyCredentialResponseSchema.safeParse(outcome.json)
  if (legacy.success) return { status: 'legacy', secret: legacy.data.reconnectSecret }

  return { status: 'invalid-response' }
}

/**
 * POSTs /api/reconnect-challenge to mint a one-time nonce challenge for
 * `origin`. Deliberately unauthenticated (no daemon token, no stored
 * credential) — see reconnect.ts's route doc comment.
 */
export async function requestReconnectChallenge(
  origin: string,
  fetchImpl: FetchLike,
  signal: AbortSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
): Promise<ChallengeResult> {
  const url = new URL('/api/reconnect-challenge', origin)
  const outcome = await postJson(url, {}, undefined, fetchImpl, signal)
  if (outcome.status === 'network-error') return { status: 'network-error' }
  if (outcome.status === 'rejected') return { status: 'rejected' }
  if (outcome.status === 'http-error') return { status: 'invalid-response' }

  const parsed = reconnectChallengeResponseSchema.safeParse(outcome.json)
  if (!parsed.success) return { status: 'invalid-response' }
  return { status: 'ok', challengeId: parsed.data.challengeId, nonce: parsed.data.nonce }
}

/**
 * POSTs /api/reconnect-session with a signed challenge response —
 * `signature` is the base64url P1363 ECDSA signature over the nonce minted
 * by requestReconnectChallenge, produced by reconnect-crypto.ts's
 * signReconnectNonce.
 */
export async function redeemReconnectSessionWithChallenge(
  origin: string,
  challengeId: string,
  signature: string,
  fetchImpl: FetchLike,
  signal: AbortSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
): Promise<RedeemResult> {
  const url = new URL('/api/reconnect-session', origin)
  const headers: HeadersInit = { 'content-type': 'application/json' }
  const outcome = await postJson(url, headers, { challengeId, signature }, fetchImpl, signal)
  return parseSessionOutcome(outcome)
}

/**
 * POSTs /api/reconnect-session presenting a legacy reconnect secret as
 * `Authorization: Bearer` — the grace-period fallback for an origin that has
 * not yet enrolled (or was refused enrolling) a keypair. The current wire
 * contract's session response carries only `token` (no rotation), but a
 * pre-migration daemon still rotates the secret on every redemption and
 * echoes the replacement — see `parseSessionOutcome`'s opportunistic
 * `rotatedSecret` detection, which the caller must persist to avoid being
 * left holding a secret the daemon already invalidated.
 */
export async function redeemReconnectSessionWithLegacySecret(
  origin: string,
  secret: string,
  fetchImpl: FetchLike,
  signal: AbortSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
): Promise<RedeemResult> {
  const url = new URL('/api/reconnect-session', origin)
  const headers: HeadersInit = { Authorization: `Bearer ${secret}` }
  const outcome = await postJson(url, headers, undefined, fetchImpl, signal)
  return parseSessionOutcome(outcome)
}

function parseSessionOutcome(outcome: PostOutcome): RedeemResult {
  if (outcome.status === 'network-error') return { status: 'network-error' }
  if (outcome.status === 'rejected') return { status: 'rejected' }
  if (outcome.status === 'http-error') return { status: 'invalid-response' }

  const parsed = reconnectSessionResponseSchema.safeParse(outcome.json)
  if (!parsed.success) return { status: 'invalid-response' }

  const rotation = legacySessionRotationSchema.safeParse(outcome.json)
  if (rotation.success) {
    return { status: 'ok', token: parsed.data.token, rotatedSecret: rotation.data.reconnectSecret }
  }
  return { status: 'ok', token: parsed.data.token }
}
