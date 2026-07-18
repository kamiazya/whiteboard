import { seedDaemonToken } from '@kamiazya/whiteboard-mcp/api-client'
import { useEffect, useRef, useState } from 'react'
import {
  type FetchLike,
  type RedeemResult,
  redeemReconnectSession,
} from '../lib/reconnect-client.js'
import { clearIfMatches, load, save } from '../lib/reconnect-credential-store.js'

export interface UseSilentReconnectOptions {
  // False when a #wb= pairing fragment was present, or when there is no
  // configured local-daemon target — the caller decides eligibility; this
  // hook only decides what to DO once eligible. Called unconditionally
  // regardless of `enabled` (hook-order safety) — pass false rather than
  // skipping the call.
  enabled: boolean
  origin: string
  fetchImpl?: FetchLike
}

export type SilentReconnectState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected'; token: string }
  | { status: 'failed'; reason: 'rejected' | 'network' }

// Keyed by (canonical-ish origin, presented secret) rather than a single
// unkeyed module promise: a plain unkeyed promise would incorrectly serve a
// stale in-flight result to a caller whose (origin, secret) pair changed
// (e.g. a settings change mid-flight), while StrictMode's double-mount for
// the SAME (origin, secret) must still dedupe to exactly one network call.
const inFlightRedeem = new Map<string, Promise<RedeemResult>>()

function redeemSingleFlight(
  origin: string,
  secret: string,
  fetchImpl: FetchLike,
): Promise<RedeemResult> {
  const key = `${origin}::${secret}`
  const existing = inFlightRedeem.get(key)
  if (existing) return existing
  const promise = redeemReconnectSession(origin, secret, fetchImpl).finally(() => {
    inFlightRedeem.delete(key)
  })
  inFlightRedeem.set(key, promise)
  return promise
}

// Test-only: clears in-flight dedupe state between tests.
export function resetSilentReconnectForTests(): void {
  inFlightRedeem.clear()
}

// Stable module-level reference for the default fetchImpl. A default
// PARAMETER expression (e.g. `= globalThis.fetch.bind(globalThis)`) would
// evaluate to a NEW function identity on every call, which — as an effect
// dependency — would re-run the effect on every render that a state update
// from within it triggers, an infinite render loop.
function defaultFetchImpl(input: string | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init)
}

/**
 * Silently redeems a stored reconnect secret for a daemon token on page
 * load, without a confirmation dialog. See reconnect-client.ts /
 * reconnect-credential-store.ts for the wire contract and persistence rules.
 *
 * A completion that arrives after this hook's (enabled, origin) inputs have
 * changed, or after unmount, still persists a rotated secret (never lose a
 * server-side rotation) but is discarded for UI purposes via a generation
 * guard — StrictMode and rapid target changes cannot leave stale state
 * showing.
 */
export function useSilentReconnect({
  enabled,
  origin,
  fetchImpl = defaultFetchImpl,
}: UseSilentReconnectOptions): SilentReconnectState {
  const [state, setState] = useState<SilentReconnectState>({ status: 'idle' })
  const generationRef = useRef(0)

  useEffect(() => {
    const myGeneration = ++generationRef.current
    const isCurrent = () => generationRef.current === myGeneration

    if (!enabled) {
      setState({ status: 'idle' })
      return
    }

    const initialSecret = load(origin)
    if (initialSecret === null) {
      setState({ status: 'idle' })
      return
    }

    setState({ status: 'connecting' })

    async function attempt(secret: string, isRetry: boolean): Promise<void> {
      const result = await redeemSingleFlight(origin, secret, fetchImpl)

      if (result.status === 'ok') {
        // Persist the rotated secret BEFORE exposing the connected state (and
        // before seeding the token) so a failed persist still leaves the
        // in-memory token usable for this session — the next load simply
        // 403s on the stale secret and falls back to the banner.
        save(origin, result.secret)
        seedDaemonToken(result.token)
        if (isCurrent()) {
          setState({ status: 'connected', token: result.token })
        }
        return
      }

      if (result.status === 'rejected') {
        // A concurrent tab may have already redeemed and rotated this
        // secret; if the store now holds a DIFFERENT value than the one we
        // just presented, retry exactly once with the winner's secret
        // instead of unconditionally clearing a still-valid credential.
        const current = load(origin)
        if (!isRetry && current !== null && current !== secret) {
          await attempt(current, true)
          return
        }
        clearIfMatches(origin, secret)
        if (isCurrent()) {
          setState({ status: 'failed', reason: 'rejected' })
        }
        return
      }

      // network-error / invalid-response: keep the stored secret, this load
      // just falls back to the one-click banner.
      if (isCurrent()) {
        setState({ status: 'failed', reason: 'network' })
      }
    }

    void attempt(initialSecret, false)
  }, [enabled, origin, fetchImpl])

  return state
}
