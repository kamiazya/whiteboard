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

const TRANSACTION_KEY = 'whiteboard:pairing-transaction'
const GRANT_FRAGMENT_PREFIX = '#wb-grant='

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

export function parseGrantFragment(hash: string): { code: string; state: string } | null {
  if (!hash.startsWith(GRANT_FRAGMENT_PREFIX)) return null
  const params = new URLSearchParams(hash.slice(1))
  const code = params.get('wb-grant')
  const state = params.get('state')
  if (!code || !state) return null
  return { code, state }
}

export type GrantConsumeResult =
  | { status: 'paired'; daemonBaseUrl: string; token: string }
  | { status: 'none' }
  | { status: 'error'; detail: string }

export async function consumeGrantFragment({
  hash,
  sessionStorage,
  fetch,
}: {
  hash: string
  sessionStorage: StorageLike
  fetch: typeof globalThis.fetch
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
  let transaction: { state?: unknown; codeVerifier?: unknown; daemonBaseUrl?: unknown }
  try {
    transaction = JSON.parse(rawTransaction)
  } catch {
    return { status: 'error', detail: 'corrupt pairing transaction' }
  }
  if (
    typeof transaction.state !== 'string' ||
    typeof transaction.codeVerifier !== 'string' ||
    typeof transaction.daemonBaseUrl !== 'string'
  ) {
    return { status: 'error', detail: 'corrupt pairing transaction' }
  }
  if (fragment.state !== transaction.state) {
    return { status: 'error', detail: 'pairing state mismatch' }
  }

  try {
    const response = await fetch(`${transaction.daemonBaseUrl}/api/pairing/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grantType: 'code',
        code: fragment.code,
        codeVerifier: transaction.codeVerifier,
      }),
    })
    if (!response.ok) {
      return { status: 'error', detail: `token exchange rejected (${response.status})` }
    }
    const body = (await response.json()) as { token?: unknown }
    if (typeof body.token !== 'string' || body.token.length === 0) {
      return { status: 'error', detail: 'token exchange returned no token' }
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
 * browser-local exactly as if nothing had been stored, and the banner
 * remains the path back to a fresh consent.
 */
export async function renewPairingToken({
  daemonBaseUrl,
  fetch,
}: {
  daemonBaseUrl: string
  fetch: typeof globalThis.fetch
}): Promise<GrantConsumeResult> {
  const base = daemonBaseUrl.replace(/\/+$/, '')
  try {
    const response = await fetch(`${base}/api/pairing/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantType: 'origin' }),
    })
    if (!response.ok) return { status: 'none' }
    const body = (await response.json()) as { token?: unknown }
    if (typeof body.token !== 'string' || body.token.length === 0) return { status: 'none' }
    return { status: 'paired', daemonBaseUrl: base, token: body.token }
  } catch {
    return { status: 'none' }
  }
}
