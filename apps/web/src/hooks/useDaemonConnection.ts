import {
  consumeDaemonConnectionFragment,
  type DaemonConnectionPayload,
  parseDaemonConnectionFragment,
} from '../lib/daemon-connection-payload.js'

export type DaemonConnectionResult =
  | { status: 'paired'; payload: DaemonConnectionPayload }
  | { status: 'none' }
  | { status: 'error'; detail: string }

type WindowLike = {
  location: { hash: string }
  __WHITEBOARD_DAEMON_TOKEN__?: unknown
}

function getWindow(): WindowLike | undefined {
  return (globalThis as { window?: WindowLike }).window
}

// Module-level lazy singleton: computed once per page load, not per mount.
// readDaemonTokenOnce() (token-store.ts) caches the FIRST read of
// window.__WHITEBOARD_DAEMON_TOKEN__ forever, including a null read, and
// deletes the global as it goes. If this were per-mount state/refs, a
// StrictMode double-mount (or any remount) would either re-consume an
// already-stripped `#wb=` fragment and see 'none', or race a read of the
// token global against the seed happening on the second mount. Computing
// once at module scope — synchronously seeding the token before returning
// 'paired' — makes both hazards impossible by construction.
//
// Consequence for pairing E2E coverage: a hash-only same-document
// navigation (e.g. setting location.hash or a client-side router push)
// never re-runs this module's top-level code, so `cached` keeps whatever
// it was computed from on first load and a later `#wb=` fragment is never
// consumed. Any end-to-end test exercising the pairing flow must force a
// full navigation (a fresh document load) for the fragment to reach
// computeDaemonConnection() at all.
let cached: DaemonConnectionResult | null = null

function computeDaemonConnection(): DaemonConnectionResult {
  const win = getWindow()
  const hash = win?.location.hash ?? ''
  const result = parseDaemonConnectionFragment(hash)

  if (result.status === 'not-present') {
    return { status: 'none' }
  }

  if (result.status === 'malformed') {
    // The undecodable payload may still carry token material (e.g. a
    // truncated/corrupted bootstrapToken), so strip it from the URL even
    // though it was never usable.
    consumeDaemonConnectionFragment()
    return { status: 'error', detail: `malformed fragment (${result.stage}): ${result.message}` }
  }

  if (result.status === 'invalid') {
    // Schema-invalid payloads (e.g. an unexpected .strict() field) can still
    // decode a real bootstrapToken, so strip the fragment before returning
    // the error — otherwise the token stays visible in the address bar,
    // history, and any screen share.
    consumeDaemonConnectionFragment()
    return { status: 'error', detail: 'invalid daemon connection payload' }
  }

  // result.status === 'ok'
  const { payload } = result
  // Seed the token BEFORE this function returns 'paired' and before the
  // fragment is stripped from history, so no code path can observe a
  // 'paired' result while readDaemonTokenOnce() would still return null.
  if (payload.authMode === 'bootstrap' && win !== undefined) {
    win.__WHITEBOARD_DAEMON_TOKEN__ = payload.bootstrapToken
  }
  consumeDaemonConnectionFragment()
  return { status: 'paired', payload }
}

/**
 * Parses (and consumes) the `#wb=` daemon-pairing fragment exactly once per
 * page load. Never throws — every failure mode collapses to
 * {status:'error'}. Safe to call from multiple components/renders: all
 * calls after the first observe the same cached result.
 */
export function useDaemonConnection(): DaemonConnectionResult {
  if (cached === null) {
    cached = computeDaemonConnection()
  }
  return cached
}

// Test-only: clears the module-level cache so each test can seed its own
// hash and observe a fresh computation. Pair with resetTokenStoreForTests()
// from '@kamiazya/whiteboard-mcp/api-client' so token-store state doesn't
// bleed across tests either.
export function resetDaemonConnectionForTests(): void {
  cached = null
}
