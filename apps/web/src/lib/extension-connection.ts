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

export async function connectThroughExtension(
  fetchFn: typeof globalThis.fetch = bridgeFetch,
): Promise<GrantConsumeResult> {
  try {
    const res = await fetchFn(`${BRIDGE_DAEMON_BASE_URL}/api/runtime/ping`)
    if (res.ok) return { status: 'paired', daemonBaseUrl: BRIDGE_DAEMON_BASE_URL, token: '' }
  } catch {
    // No extension, no host, or no daemon behind it: nothing to connect.
  }
  return { status: 'none' }
}
