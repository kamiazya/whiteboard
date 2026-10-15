/**
 * ADR-0050: connecting to a daemon through the whiteboard extension. There is
 * no pairing to do — the extension admits this origin, the browser starts the
 * native host only for that extension, and the host reaches the daemon over
 * its owner-only socket with the daemon's own credential — so a connection is
 * a daemon that answers.
 */
import { runtimePingApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { BRIDGE_DAEMON_BASE_URL } from './bridge-address.js'
import { bridgeFetch } from './bridge-loader.js'

/** What asking for the daemon through the extension answered. */
export type ExtensionConnection =
  | { status: 'connected'; daemonBaseUrl: string }
  /**
   * `refusal` is what the daemon record said when the native host would not
   * relay — another version's daemon still running, a record this user cannot
   * read — and is absent when nothing more specific than "no daemon" is known.
   */
  | { status: 'none'; refusal?: string }

/**
 * How long a reconnection waits: the app says "Connecting…" until it answers.
 * Starting the native host is a process launch, so this is not a round trip.
 */
export const CONNECT_TIMEOUT_MS = 10_000

export async function connectThroughExtension(
  fetchFn: typeof globalThis.fetch = bridgeFetch,
): Promise<ExtensionConnection> {
  const giveUp = new AbortController()
  const timer = setTimeout(() => giveUp.abort(), CONNECT_TIMEOUT_MS)
  try {
    const res = await fetchFn(`${BRIDGE_DAEMON_BASE_URL}${runtimePingApiUrl()}`, {
      signal: giveUp.signal,
    })
    if (res.ok) return { status: 'connected', daemonBaseUrl: BRIDGE_DAEMON_BASE_URL }
  } catch (err) {
    // No extension, no host, no daemon behind it, or no answer in time — or a
    // daemon record the host refused, whose words are the person's next step.
    const refusal = daemonRecordRefusal(err)
    if (refusal !== null) return { status: 'none', refusal }
  } finally {
    clearTimeout(timer)
  }
  return { status: 'none' }
}

/**
 * The bridge rejects a host `error` frame as `TypeError('<reason>: <message>')`
 * (extension-bridge-fetch.ts). Only `daemon-unreachable` carries a message
 * meant for the person; any other kind's text is a transport detail and stays
 * behind the generic line, as does the host's plain "no daemon is running",
 * which the generic line already says better.
 */
const DAEMON_UNREACHABLE = 'daemon-unreachable: '
const NO_DAEMON = 'no daemon is running'

function daemonRecordRefusal(err: unknown): string | null {
  if (!(err instanceof TypeError) || !err.message.startsWith(DAEMON_UNREACHABLE)) return null
  const message = err.message.slice(DAEMON_UNREACHABLE.length).trim()
  return message === '' || message === NO_DAEMON ? null : message
}
