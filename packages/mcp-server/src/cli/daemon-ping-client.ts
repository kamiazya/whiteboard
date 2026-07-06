// Shared /api/runtime/ping client for the CLI's daemon-identity checks
// (server-status, server-stop, server-doctor). Parsing the response through
// daemonPingResponseSchema here — rather than a hand-written cast at each
// call site — means a future field change to the schema only needs to be
// kept in sync in one place.

import { daemonPingResponseSchema } from '../shared/api-contracts/runtime.js'
import type { DaemonPingResponse } from '../shared/api-contracts/runtime.js'

const DEFAULT_TIMEOUT_MS = 2000

export function resolveConnectHost(bindHost: string): string {
  if (bindHost === '0.0.0.0') return '127.0.0.1'
  if (bindHost === '::' || bindHost === '::0') return '[::1]'
  // Bare IPv6 addresses contain colons — bracket them for URL construction.
  if (bindHost.includes(':') && !bindHost.startsWith('[')) return `[${bindHost}]`
  return bindHost
}

/**
 * Fetch and validate /api/runtime/ping. Returns null on any failure —
 * network error, non-2xx response, or a body that fails schema validation —
 * so callers can fail closed the same way a plain boolean check did before.
 */
export async function fetchDaemonPing(
  host: string,
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DaemonPingResponse | null> {
  const connectHost = resolveConnectHost(host)
  try {
    const res = await fetch(`http://${connectHost}:${port}/api/runtime/ping`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const body = await res.json()
    const parsed = daemonPingResponseSchema.safeParse(body)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
