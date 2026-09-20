/**
 * ADR-0042 decision 2/3 (and ADR-0043 decision 3): binds this pairing
 * session to the person's own passkey, so the daemon will issue this
 * session a replica key instead of withholding it with
 * `requires_person_session`. Distinct from `passkey-attestation.ts`'s move
 * signature — that proves who approved ONE promotion; this proves who is
 * asking for the session's replica reads, for as long as the session lasts.
 *
 * The two `/api/pairing/session-assert*` literals are spelled out (never
 * built from a helper) because `keeper-parity.test.ts`'s daemon-reach scan
 * matches on `['"\`]\/api\/` — this file's ledger entry stays live rather
 * than silently going stale the way a helper-hidden URL would.
 */
import type {
  SessionAssertChallengeResponse,
  SessionAssertResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import {
  sessionAssertChallengeResponseSchema,
  sessionAssertResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import type { BindOutcome } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  assertWithRegisteredPasskey,
  getRegisteredPasskey,
  type PasskeyCredentials,
} from './passkey-attestation.js'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** POSTs to `path` and answers the parsed body, or a `BindOutcome` failure describing why it could not. */
async function postAndParse<T>(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; outcome: BindOutcome & { ok: false } }> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  } catch {
    return { ok: false, outcome: { ok: false, reason: 'unreachable' } }
  }
  let json: unknown
  try {
    json = await response.json()
  } catch {
    json = undefined
  }
  if (!response.ok) return { ok: false, outcome: { ok: false, reason: 'rejected' } }
  const parsed = schema.safeParse(json)
  if (!parsed.success || parsed.data === undefined) {
    return { ok: false, outcome: { ok: false, reason: 'rejected' } }
  }
  return { ok: true, data: parsed.data }
}

/**
 * Mints a session-assert challenge, signs it with the passkey registered for
 * this daemon, and posts the assertion back — the daemon then binds this
 * pairing session to the person the passkey belongs to.
 */
export async function bindPasskeySession({
  daemonBaseUrl,
  fetch,
  credentials = globalThis.navigator?.credentials,
  storage = globalThis.localStorage,
}: {
  daemonBaseUrl: string
  /** A daemon fetch: the pairing bearer rides on it. */
  fetch: typeof globalThis.fetch
  credentials?: PasskeyCredentials
  storage?: StorageLike
}): Promise<BindOutcome> {
  if (getRegisteredPasskey(daemonBaseUrl, storage) === null || credentials === undefined) {
    return { ok: false, reason: 'no-passkey' }
  }

  // Relative — resolved against `daemonBaseUrl` by the daemon fetch wrapper
  // this is always called with in production (`createDaemonFetch`), and
  // spelled with the quote directly before `/api/` on purpose: that is
  // literally what `keeper-parity.test.ts`'s daemon-reach scan matches, so
  // this file's ledger entry stays live instead of silently going stale.
  const challengeResult = await postAndParse<SessionAssertChallengeResponse>(
    fetch,
    '/api/pairing/session-assert/challenge',
    sessionAssertChallengeResponseSchema,
  )
  if (!challengeResult.ok) return challengeResult.outcome

  const attestOutcome = await assertWithRegisteredPasskey({
    daemonBaseUrl,
    challenge: base64UrlToBytes(challengeResult.data.challenge),
    credentials,
    storage,
  })
  if (attestOutcome === null) return { ok: false, reason: 'no-passkey' }
  if (!attestOutcome.ok) {
    return { ok: false, reason: attestOutcome.reason === 'cancelled' ? 'cancelled' : 'rejected' }
  }

  const { kind: _kind, ...assertBody } = attestOutcome.attestation
  const assertResult = await postAndParse<SessionAssertResponse>(
    fetch,
    '/api/pairing/session-assert',
    sessionAssertResponseSchema,
    assertBody,
  )
  if (!assertResult.ok) return assertResult.outcome
  return { ok: true }
}
