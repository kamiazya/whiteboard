import { seedDaemonToken } from '@kamiazya/whiteboard-mcp/api-client'
import { useEffect, useRef, useState } from 'react'
import {
  type FetchLike,
  type RedeemResult,
  redeemReconnectSessionWithChallenge,
  redeemReconnectSessionWithLegacySecret,
  requestReconnectChallenge,
} from '../lib/reconnect-client.js'
import {
  clearIfMatches,
  clearIfOrigin as clearLegacySecretIfOrigin,
  load as loadLegacySecret,
  save as saveLegacySecret,
} from '../lib/reconnect-credential-store.js'
import { signReconnectNonce } from '../lib/reconnect-crypto.js'
import { enrollForReconnectOnce } from '../lib/reconnect-enrollment.js'
import {
  clearKeypair,
  loadKeypair,
  markKeypairConfirmed,
  type ReconnectKeypairRecord,
} from '../lib/reconnect-keypair-store.js'

// Injectable seams so unit tests can exercise the branching logic (keypair
// vs legacy, rejected vs network-error, etc.) with fakes instead of a real
// IndexedDB keypair store or WebCrypto signature (jsdom has neither — see
// test-layer-selection).
export interface UseSilentReconnectDeps {
  loadKeypair: (origin: string) => Promise<ReconnectKeypairRecord | null>
  markKeypairConfirmed: (origin: string, keyId: string) => Promise<void>
  clearKeypair: (origin: string, keyId: string) => Promise<void>
  signReconnectNonce: (privateKey: CryptoKey, nonce: string) => Promise<string>
}

const defaultDeps: UseSilentReconnectDeps = {
  loadKeypair,
  markKeypairConfirmed,
  clearKeypair,
  signReconnectNonce,
}

export interface UseSilentReconnectOptions {
  // False when a #wb= pairing fragment was present, or when there is no
  // configured local-daemon target — the caller decides eligibility; this
  // hook only decides what to DO once eligible. Called unconditionally
  // regardless of `enabled` (hook-order safety) — pass false rather than
  // skipping the call.
  enabled: boolean
  origin: string
  fetchImpl?: FetchLike
  // Like `fetchImpl`, must be a STABLE reference across re-renders (a module-
  // level constant, or memoized) — it is an effect dependency, so a new
  // object identity on every render (e.g. inlining `{...}` at the call site)
  // re-fires the effect on every state update this hook makes, an infinite
  // render loop.
  deps?: UseSilentReconnectDeps
}

export type SilentReconnectState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected'; token: string }
  | { status: 'failed'; reason: 'rejected' | 'network' }

// Keyed by origin (keypair path) / (origin, secret) (legacy path) rather than
// a single unkeyed module promise: StrictMode's double-mount for the SAME
// target must dedupe to exactly one network round trip, while a target that
// actually changed mid-flight must not share the stale in-flight promise.
const inFlightKeypairAttempt = new Map<string, Promise<RedeemResult>>()
const inFlightLegacyAttempt = new Map<string, Promise<RedeemResult>>()

function singleFlight(
  map: Map<string, Promise<RedeemResult>>,
  key: string,
  run: () => Promise<RedeemResult>,
): Promise<RedeemResult> {
  const existing = map.get(key)
  if (existing) return existing
  const promise = run().finally(() => map.delete(key))
  map.set(key, promise)
  return promise
}

// Test-only: clears in-flight dedupe state between tests.
export function resetSilentReconnectForTests(): void {
  inFlightKeypairAttempt.clear()
  inFlightLegacyAttempt.clear()
}

// Stable module-level reference for the default fetchImpl. A default
// PARAMETER expression (e.g. `= globalThis.fetch.bind(globalThis)`) would
// evaluate to a NEW function identity on every call, which — as an effect
// dependency — would re-run the effect on every render that a state update
// from within it triggers, an infinite render loop.
function defaultFetchImpl(input: string | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init)
}

async function attemptKeypairChallenge(
  origin: string,
  privateKey: CryptoKey,
  fetchImpl: FetchLike,
  deps: UseSilentReconnectDeps,
): Promise<RedeemResult> {
  const challenge = await requestReconnectChallenge(origin, fetchImpl)
  if (challenge.status !== 'ok') {
    return { status: challenge.status }
  }
  // signReconnectNonce can reject (incompatible CryptoKey, browser crypto
  // failure) rather than just returning a bad signature the daemon rejects.
  // Treated the same as a network error — keep the stored keypair, no
  // legacy fallback — instead of letting the rejection escape this
  // singleFlight-wrapped call as an unhandled promise rejection that leaves
  // the UI stuck in 'connecting' forever.
  let signature: string
  try {
    signature = await deps.signReconnectNonce(privateKey, challenge.nonce)
  } catch {
    return { status: 'network-error' }
  }
  return redeemReconnectSessionWithChallenge(origin, challenge.challengeId, signature, fetchImpl)
}

/**
 * Silently redeems an enrolled WebCrypto keypair (preferred) — proving
 * possession via a signed challenge-response, no user gesture required — or
 * a legacy Bearer secret (grace-period fallback for an origin that never
 * enrolled a keypair, or whose keypair the daemon just rejected) for a
 * daemon token on page load, without a confirmation dialog. See
 * reconnect-client.ts / reconnect-keypair-store.ts / reconnect-credential-
 * store.ts for the wire contract and persistence rules.
 *
 * A completion that arrives after this hook's (enabled, origin) inputs have
 * changed, or after unmount, still performs its persistence side effects
 * (confirming/clearing the keypair record, clearing a rejected legacy
 * secret) — those live on the shared single-flight promise, not gated by
 * this hook instance's lifecycle — but is discarded for UI purposes via a
 * generation guard, so StrictMode and rapid target changes cannot leave
 * stale state showing.
 */
export function useSilentReconnect({
  enabled,
  origin,
  fetchImpl = defaultFetchImpl,
  deps = defaultDeps,
}: UseSilentReconnectOptions): SilentReconnectState {
  const [state, setState] = useState<SilentReconnectState>({ status: 'idle' })
  const generationRef = useRef(0)

  useEffect(() => {
    const myGeneration = ++generationRef.current
    const isCurrent = () => generationRef.current === myGeneration
    // Cleanup invalidates this run's generation so completions that land
    // after unmount (not only after an input change) are also treated as
    // stale — without it, the LAST mounted generation would stay "current"
    // forever.
    const invalidate = () => {
      generationRef.current += 1
    }

    if (!enabled) {
      setState({ status: 'idle' })
      return invalidate
    }

    // `noCredentialFallbackReason` distinguishes "nothing was ever attempted"
    // (idle — the ordinary no-credential case) from "the keypair attempt
    // above was already rejected and there is simply no legacy secret to
    // fall back to" (failed(rejected) — an attempt genuinely failed, so the
    // caller should show the reconnect-failed banner rather than silently
    // idling).
    async function tryLegacy(noCredentialFallbackReason?: 'rejected'): Promise<void> {
      const secret = loadLegacySecret(origin)
      if (secret === null) {
        if (isCurrent()) {
          setState(
            noCredentialFallbackReason
              ? { status: 'failed', reason: noCredentialFallbackReason }
              : { status: 'idle' },
          )
        }
        return
      }
      if (isCurrent()) setState({ status: 'connecting' })
      const result = await singleFlight(inFlightLegacyAttempt, `${origin}::${secret}`, () =>
        redeemReconnectSessionWithLegacySecret(origin, secret, fetchImpl),
      )
      if (result.status === 'ok') {
        // A pre-migration daemon still rotates the presented secret on every
        // redemption (see reconnect-client.ts's parseSessionOutcome) — persist
        // the replacement now, or the next reload presents a secret the
        // daemon already invalidated and gets rejected. `rotatedSecret`'s
        // presence is also this response's ONLY signal that the daemon on
        // the other end is pre-migration: it means /api/reconnect-session
        // rotated a plaintext secret rather than returning a bare token, so
        // /api/reconnect-credential on that same daemon would too — it
        // cannot honor a public-key enrollment and would instead issue yet
        // another plaintext secret. Attempting enrollment here anyway is
        // fire-and-forget; if the tab closes or reloads before that second
        // response lands, the daemon has still committed the rotation
        // server-side, leaving the browser holding the secret just saved
        // above but already invalidated — forcing a re-pairing. Skipping
        // enrollment whenever `rotatedSecret` is present avoids that
        // needless second rotation entirely; only a modern (token-only)
        // response below attempts the keypair upgrade.
        if (result.rotatedSecret) {
          saveLegacySecret(origin, result.rotatedSecret)
        } else {
          // Best-effort upgrade: a browser that just proved possession of
          // the legacy secret against a modern daemon has no keypair yet
          // (the `run()` caller only reaches `tryLegacy` when `loadKeypair`
          // returned null), so enroll one now rather than waiting for the
          // legacy secret's 90-day absolute TTL to force a re-pairing.
          // enrollForReconnectOnce never throws synchronously in practice,
          // but it is invoked fire-and-forget on purpose: its success/
          // failure must never affect this reconnect's own state
          // transition.
          try {
            enrollForReconnectOnce(origin, result.token, fetchImpl)
          } catch {
            // Non-fatal by contract — see comment above.
          }
        }
        if (isCurrent()) {
          seedDaemonToken(result.token)
          setState({ status: 'connected', token: result.token })
        }
        return
      }
      if (result.status === 'rejected') {
        // A concurrent tab may have already rotated or revoked this secret;
        // only clear it if the store still holds exactly the value we just
        // presented.
        clearIfMatches(origin, secret)
      }
      if (isCurrent()) {
        setState({
          status: 'failed',
          reason: result.status === 'rejected' ? 'rejected' : 'network',
        })
      }
    }

    async function run(): Promise<void> {
      const keypair = await deps.loadKeypair(origin).catch(() => null)

      if (!keypair) {
        await tryLegacy()
        return
      }

      if (isCurrent()) setState({ status: 'connecting' })
      const result = await singleFlight(inFlightKeypairAttempt, origin, () =>
        attemptKeypairChallenge(origin, keypair.privateKey, fetchImpl, deps),
      )

      if (result.status === 'ok') {
        // First proof the private key actually works end-to-end — promote
        // the keypair record and retire the legacy secret only now, never
        // right after enrollment's POST /api/reconnect-credential succeeded.
        if (keypair.status === 'pending') {
          await deps.markKeypairConfirmed(origin, keypair.keyId).catch(() => {})
          // Conditional on origin, not unconditional: a completion that
          // lands late can otherwise race a DIFFERENT origin's legacy
          // secret that a concurrent tab saved after this attempt started,
          // erasing credentials this hook has no business touching.
          clearLegacySecretIfOrigin(origin)
        }
        if (isCurrent()) {
          seedDaemonToken(result.token)
          setState({ status: 'connected', token: result.token })
        }
        return
      }

      if (result.status === 'rejected') {
        // The daemon no longer honors this keypair (revoked / expired /
        // origin delisted) — drop it and fall back to a legacy secret, if
        // one is still around, rather than getting stuck retrying a key
        // that will never be accepted again.
        await deps.clearKeypair(origin, keypair.keyId).catch(() => {})
        await tryLegacy('rejected')
        return
      }

      // network-error / invalid-response: keep the stored keypair, this
      // load just falls back to the one-click banner.
      if (isCurrent()) {
        setState({ status: 'failed', reason: 'network' })
      }
    }

    void run()
    return invalidate
  }, [enabled, origin, fetchImpl, deps])

  return state
}
