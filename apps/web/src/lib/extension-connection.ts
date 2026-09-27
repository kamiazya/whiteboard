/**
 * ADR-0050: connecting to a daemon through the whiteboard extension. There is
 * no pairing to do — the extension admits this origin, the browser starts the
 * native host only for that extension, and the host reaches the daemon over
 * its owner-only socket with the daemon's own credential — so a connection is
 * a daemon that answers. The page holds no token (the grant's is empty).
 */
import { BRIDGE_DAEMON_BASE_URL } from './bridge-address.js'
import { bridgeFetch } from './bridge-loader.js'
import type { GrantConsumeResult } from './pairing-grant.js'

/**
 * How long a reconnection waits: the app says "Connecting…" until it answers.
 * Starting the native host is a process launch, so this is not a round trip.
 */
export const CONNECT_TIMEOUT_MS = 10_000

export async function connectThroughExtension(
  fetchFn: typeof globalThis.fetch = bridgeFetch,
): Promise<GrantConsumeResult> {
  const giveUp = new AbortController()
  const timer = setTimeout(() => giveUp.abort(), CONNECT_TIMEOUT_MS)
  try {
    const res = await fetchFn(`${BRIDGE_DAEMON_BASE_URL}/api/runtime/ping`, {
      signal: giveUp.signal,
    })
    if (res.ok) return { status: 'paired', daemonBaseUrl: BRIDGE_DAEMON_BASE_URL, token: '' }
  } catch {
    // No extension, no host, no daemon behind it, or no answer in time.
  } finally {
    clearTimeout(timer)
  }
  return { status: 'none' }
}
