import { enrollReconnectCredential, type FetchLike } from './reconnect-client.js'
import { save } from './reconnect-credential-store.js'

function defaultFetchImpl(input: string | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init)
}

// Module-level single-flight (not per-component state) so a StrictMode
// double-render, or two components racing to enroll on the same page load,
// cannot fire two /api/reconnect-credential requests and risk persisting a
// server-superseded secret (trustOrigin replaces the trust record on each
// call — see web-origin-trust-store.ts).
let inFlight: Promise<void> | null = null

// Test-only: clears single-flight state between tests.
export function resetReconnectEnrollmentForTests(): void {
  inFlight = null
}

/**
 * Enrolls `origin` for silent reconnect after a successful #wb= pairing.
 * Attempted for every authMode (including a tokenless daemon, where
 * `daemonToken` is null and the Authorization header is omitted entirely —
 * the daemon's auth middleware treats an absent token as authenticated).
 * Failure is non-fatal and does not throw: no secret is persisted, so a
 * later page load simply has no silent-reconnect option and falls back to
 * the existing DaemonDetectedBanner one-click flow.
 */
export function enrollForReconnectOnce(
  origin: string,
  daemonToken: string | null,
  fetchImpl: FetchLike = defaultFetchImpl,
): void {
  if (inFlight) return
  inFlight = enrollReconnectCredential(origin, daemonToken, fetchImpl)
    .then((result) => {
      if (result.status === 'ok') {
        save(origin, result.secret)
      }
    })
    .catch(() => {
      // Non-fatal by contract; see doc comment above.
    })
}
