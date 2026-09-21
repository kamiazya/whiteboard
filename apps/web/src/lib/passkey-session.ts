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

import type { Attestation } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  sessionAssertChallengeResponseSchema,
  sessionAssertResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import type { BindOutcome } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import type { z } from 'zod'
import {
  assertWithRegisteredPasskey,
  base64UrlToBytes,
  getRegisteredPasskey,
  type PasskeyCredentials,
  type StorageLike,
} from './passkey-attestation.js'
import { prfInputForDaemon } from './passkey-prf.js'

const rejected = { ok: false, outcome: { ok: false, reason: 'rejected' } } as const

/** POSTs to `url` and answers the parsed body, or a `BindOutcome` failure describing why it could not. */
async function postAndParse<T>(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  schema: z.ZodType<T>,
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
  if (!response.ok) return rejected
  const parsed = schema.safeParse(await response.json().catch(() => undefined))
  return parsed.success ? { ok: true, data: parsed.data } : rejected
}

/**
 * Signs a base64url challenge with this daemon's registered passkey, and
 * translates every way that can fail into the `BindOutcome` the caller
 * answers with.
 *
 * Carries the `prf` input, so the ONE gesture does both jobs (ADR-0042
 * decision 6 + ADR-0039 decision 6): it proves who is asking AND yields the
 * material that wraps this daemon's replica keys for a cold start. An
 * authenticator that ignores the extension still produces a whole
 * attestation, which is why nothing branches on the output being absent —
 * only the cold start is lost, and `prfOutput` says so by being optional.
 */
async function signChallenge({
  daemonBaseUrl,
  challenge,
  credentials,
  storage,
}: {
  daemonBaseUrl: string
  challenge: string
  credentials: PasskeyCredentials | undefined
  storage: StorageLike
}): Promise<
  | { ok: true; attestation: Attestation; prfOutput?: Uint8Array<ArrayBuffer> }
  | { ok: false; outcome: BindOutcome & { ok: false } }
> {
  const outcome = await assertWithRegisteredPasskey({
    daemonBaseUrl,
    challenge: base64UrlToBytes(challenge),
    prfInput: await prfInputForDaemon(daemonBaseUrl),
    credentials,
    storage,
  })
  if (outcome === null) return { ok: false, outcome: { ok: false, reason: 'no-passkey' } }
  if (!outcome.ok) {
    return {
      ok: false,
      outcome: { ok: false, reason: outcome.reason === 'cancelled' ? 'cancelled' : 'rejected' },
    }
  }
  return {
    ok: true,
    attestation: outcome.attestation,
    ...(outcome.prfOutput === undefined ? {} : { prfOutput: outcome.prfOutput }),
  }
}

/**
 * Mints a session-assert challenge, signs it with the passkey registered for
 * this daemon, and posts the assertion back — the daemon then binds this
 * pairing session to the person the passkey belongs to, and answers with the
 * key material that assertion produced (see `signChallenge`).
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
  const challengeResult = await postAndParse(
    fetch,
    '/api/pairing/session-assert/challenge',
    sessionAssertChallengeResponseSchema,
  )
  if (!challengeResult.ok) return challengeResult.outcome

  const signed = await signChallenge({
    daemonBaseUrl,
    challenge: challengeResult.data.challenge,
    credentials,
    storage,
  })
  if (!signed.ok) return signed.outcome

  const { kind: _kind, ...assertBody } = signed.attestation
  const assertResult = await postAndParse(
    fetch,
    '/api/pairing/session-assert',
    sessionAssertResponseSchema,
    assertBody,
  )
  if (!assertResult.ok) return assertResult.outcome
  return {
    ok: true,
    ...(signed.prfOutput === undefined ? {} : { prfOutput: signed.prfOutput }),
  }
}
