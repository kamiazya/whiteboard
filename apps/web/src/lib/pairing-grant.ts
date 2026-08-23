/**
 * Hosted-side half of the pairing-grant flow (hosted-PWA-first pairing).
 *
 * First consent is a redirect round-trip: `beginPairingGrant` stashes a
 * state nonce + PKCE verifier + the target daemon baseUrl in
 * sessionStorage and top-level-navigates to the daemon's own /pair consent
 * page. After the user clicks Approve there, the daemon redirects back to
 * this origin with `#wb-grant=<code>&state=<state>` — a single-use 60s
 * code, never a token: the token is only ever obtained by
 * `consumeGrantFragment`'s direct POST exchange, so no credential rides
 * the URL bar, history, or a screen share.
 *
 * The state nonce proves intra-transaction continuity only (sessionStorage
 * is cloned into windows this page opens, per the design review), which is
 * why approval always requires a human click on the DAEMON origin and why
 * renewals skip this file entirely (Origin-authenticated direct fetch in
 * the caller).
 */

import { pairingTokenResponseSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import { z } from 'zod'
import { bareOriginSchema } from '../runtime-config.js'
import {
  createChallengeNonce,
  getPinnedIdentity,
  pinIdentity,
  sha256Base64Url,
  verifyIdentitySignature,
} from './daemon-identity-pin.js'

const TRANSACTION_KEY = 'whiteboard:pairing-transaction'
const GRANT_FRAGMENT_PREFIX = '#wb-grant='

// The stash survives a top-level navigation and is same-origin writable, so it
// re-enters this module as untrusted input however it left. `daemonBaseUrl` is
// the load-bearing field: the exchange POSTs the PKCE verifier and the
// single-use code to it, so it reuses runtime-config's bareOriginSchema rather
// than a looser string check — a value with a path, query or credentials is not
// an origin this app ever wrote, and must not be one it redeems against.
const pairingTransactionSchema = z.object({
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  daemonBaseUrl: bareOriginSchema,
})

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function randomBase64Url(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return btoa(String.fromCharCode(...buffer))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = randomBase64Url(32)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
  return { codeVerifier, codeChallenge }
}

export async function beginPairingGrant({
  daemonBaseUrl,
  hostedOrigin,
  sessionStorage,
  navigate,
}: {
  daemonBaseUrl: string
  hostedOrigin: string
  sessionStorage: StorageLike
  navigate: (url: string) => void
}): Promise<void> {
  const { codeVerifier, codeChallenge } = await createPkcePair()
  const state = randomBase64Url(16)
  sessionStorage.setItem(
    TRANSACTION_KEY,
    JSON.stringify({ state, codeVerifier, daemonBaseUrl: daemonBaseUrl.replace(/\/+$/, '') }),
  )
  const url = new URL('/pair', daemonBaseUrl)
  url.searchParams.set('origin', hostedOrigin)
  url.searchParams.set('challenge', codeChallenge)
  url.searchParams.set('state', state)
  navigate(url.toString())
}

export function parseGrantFragment(
  hash: string,
): { code: string; state: string; identity: string | null } | null {
  if (!hash.startsWith(GRANT_FRAGMENT_PREFIX)) return null
  const params = new URLSearchParams(hash.slice(1))
  const code = params.get('wb-grant')
  const state = params.get('state')
  if (!code || !state) return null
  // The daemon-served consent page embeds the daemon's public key here —
  // learned over the SAME top-level navigation the user just approved on,
  // which is the trust anchor the pin inherits. Absent on legacy daemons.
  return { code, state, identity: params.get('identity') }
}

export type GrantConsumeResult =
  | { status: 'paired'; daemonBaseUrl: string; token: string }
  | { status: 'none' }
  | { status: 'error'; detail: string }
  /** A PINNED daemon answered with a wrong/missing identity signature.
   *  Renewal is refused (fail closed) but the pin is kept so the
   *  key-changed warning UI has its evidence; re-approving on /pair
   *  re-pins. */
  | { status: 'identity-mismatch'; daemonBaseUrl: string }

export async function consumeGrantFragment({
  hash,
  sessionStorage,
  fetch,
  hostedOrigin = globalThis.location.origin,
  pinStorage = globalThis.localStorage,
}: {
  hash: string
  sessionStorage: StorageLike
  fetch: typeof globalThis.fetch
  hostedOrigin?: string
  pinStorage?: StorageLike
}): Promise<GrantConsumeResult> {
  const fragment = parseGrantFragment(hash)
  if (fragment === null) return { status: 'none' }

  const rawTransaction = sessionStorage.getItem(TRANSACTION_KEY)
  // The transaction is single-use either way: a replayed or forged
  // fragment must never get a second chance against a stale stash.
  sessionStorage.removeItem(TRANSACTION_KEY)
  if (rawTransaction === null) {
    return { status: 'error', detail: 'no pairing transaction in progress' }
  }
  let parsedTransaction: unknown
  try {
    parsedTransaction = JSON.parse(rawTransaction)
  } catch {
    return { status: 'error', detail: 'corrupt pairing transaction' }
  }
  const validated = pairingTransactionSchema.safeParse(parsedTransaction)
  if (!validated.success) {
    return { status: 'error', detail: 'corrupt pairing transaction' }
  }
  const transaction = validated.data
  if (fragment.state !== transaction.state) {
    return { status: 'error', detail: 'pairing state mismatch' }
  }

  const nonce = createChallengeNonce()
  try {
    const response = await fetch(`${transaction.daemonBaseUrl}/api/pairing/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grantType: 'code',
        code: fragment.code,
        codeVerifier: transaction.codeVerifier,
        nonce,
      }),
    })
    if (!response.ok) {
      return { status: 'error', detail: `token exchange rejected (${response.status})` }
    }
    const parsed = pairingTokenResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      return { status: 'error', detail: 'token exchange returned a malformed response' }
    }
    const body = parsed.data
    if (body.token.length === 0) {
      return { status: 'error', detail: 'token exchange returned no token' }
    }
    if (fragment.identity !== null) {
      // The key the user just approved (fragment) must be the key that
      // signs the credential handed over — anything else is refused.
      const verified =
        body.identity?.publicKey === fragment.identity &&
        typeof body.identity?.signature === 'string' &&
        (await verifyIdentitySignature({
          publicKey: fragment.identity,
          parts: [
            'wb-token-v1',
            nonce,
            hostedOrigin,
            await sha256Base64Url(body.token),
            body.expiresAt,
          ],
          signature: body.identity.signature,
        }))
      if (!verified) {
        return { status: 'error', detail: 'daemon identity verification failed' }
      }
      pinIdentity(
        transaction.daemonBaseUrl,
        { alg: 'Ed25519', publicKey: fragment.identity },
        pinStorage,
      )
    }
    return { status: 'paired', daemonBaseUrl: transaction.daemonBaseUrl, token: body.token }
  } catch (error) {
    return { status: 'error', detail: `token exchange failed: ${String(error)}` }
  }
}

/**
 * Silent renewal on a later visit: the browser-enforced Origin header
 * matched against the daemon's persisted grant is the whole credential, so
 * this never redirects and carries no secret. A 403 (grant revoked, or a
 * restarted daemon that lost nothing but was never granted) and an
 * unreachable daemon both collapse to 'none' — the caller falls back to
 * the browser exactly as if nothing had been stored, and the banner
 * remains the path back to a fresh consent.
 */
export async function renewPairingToken({
  daemonBaseUrl,
  fetch,
  hostedOrigin = globalThis.location.origin,
  pinStorage = globalThis.localStorage,
}: {
  daemonBaseUrl: string
  fetch: typeof globalThis.fetch
  hostedOrigin?: string
  pinStorage?: StorageLike
}): Promise<GrantConsumeResult> {
  const base = daemonBaseUrl.replace(/\/+$/, '')
  const pinned = getPinnedIdentity(base, pinStorage)
  const nonce = pinned !== null ? createChallengeNonce() : undefined
  try {
    const response = await fetch(`${base}/api/pairing/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantType: 'origin', ...(nonce !== undefined ? { nonce } : {}) }),
    })
    if (!response.ok) return { status: 'none' }
    const parsed = pairingTokenResponseSchema.safeParse(await response.json())
    if (!parsed.success) return { status: 'none' }
    const body = parsed.data
    if (body.token.length === 0) return { status: 'none' }
    if (pinned !== null && nonce !== undefined) {
      // Verified against the PIN, never the advertised key: a squatter (or
      // a rotated daemon) fails closed here and the user re-approves on
      // /pair, which re-pins.
      const verified =
        body.identity?.publicKey === pinned.publicKey &&
        typeof body.identity?.signature === 'string' &&
        (await verifyIdentitySignature({
          publicKey: pinned.publicKey,
          parts: [
            'wb-token-v1',
            nonce,
            hostedOrigin,
            await sha256Base64Url(body.token),
            body.expiresAt,
          ],
          signature: body.identity.signature,
        }))
      if (!verified) return { status: 'identity-mismatch', daemonBaseUrl: base }
    }
    return { status: 'paired', daemonBaseUrl: base, token: body.token }
  } catch {
    return { status: 'none' }
  }
}
