import { daemonPingResponseSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import { z } from 'zod'

// Default loopback origin for the local daemon (matches
// packages/mcp-server's default runtime port). Callers that know a
// non-default port (settings.storage.localDaemonBaseUrl) pass it explicitly.
export const DEFAULT_DAEMON_BASE_URL = 'http://127.0.0.1:3099'

const DEFAULT_TIMEOUT_MS = 2000
const MEMO_KEY_PREFIX = 'whiteboard:daemon-probe:'

// Single source of truth for the probe's failure classification, shared by
// the in-memory result type and the persisted sessionStorage memo (see
// readMemo below) so the two can never drift apart.
export const probeFailureReasonSchema = z.enum([
  'timeout',
  'http-error',
  'malformed',
  'network',
  'blocked',
  'refused',
])
export type ProbeFailureReason = z.infer<typeof probeFailureReasonSchema>

// Single source of truth for the probe result shape, shared by the
// in-memory return value and the persisted sessionStorage memo (readMemo /
// writeMemo below) — deriving the type via z.infer keeps a future field
// addition from silently drifting between the two.
export const daemonProbeResultSchema = z.union([
  z.object({ detected: z.literal(true), instanceId: z.string() }),
  z.object({ detected: z.literal(false), reason: probeFailureReasonSchema }),
])
export type DaemonProbeResult = z.infer<typeof daemonProbeResultSchema>

export interface ProbeDaemonOptions {
  fetch: typeof globalThis.fetch
  timeoutMs?: number
  forceRecheck?: boolean
  signal?: AbortSignal
  // Scheme of the page origin the probe runs from. Drives the
  // refused-vs-blocked-vs-network classification below (see runProbe).
  // Optional and backward compatible: omitting it preserves the pre-tier
  // behavior of classifying every non-timeout fetch rejection as 'network'.
  pageOriginScheme?: 'http' | 'https'
}

// WebKit's mixed-content block surfaces as a fetch rejection with this exact
// message (measured against Safari/WebKit hitting an https page fetching a
// loopback http origin — see .claude/investigation-lna-hosted-daemon-transport.md
// F3). Chromium/Firefox hitting the daemon's CORS gate from an unlisted
// origin (F4) reject with the unrelated "Failed to fetch" message, which
// this deliberately does NOT match: that failure is a same-engine CORS
// rejection, not proof the browser refused to attempt the request, so it
// stays classified as 'network' (-> tier 'unknown') rather than 'blocked'.
const WEBKIT_MIXED_CONTENT_BLOCK_MESSAGE = 'Load failed'

function classifyFetchRejection(
  error: unknown,
  pageOriginScheme: 'http' | 'https' | undefined,
): ProbeFailureReason {
  if (pageOriginScheme === 'http') {
    // A same-scheme loopback fetch can never be blocked by the browser, so
    // any rejection here proves the network path is open (nothing answered,
    // or the connection was refused) — never a browser-side block.
    return 'refused'
  }
  if (
    pageOriginScheme === 'https' &&
    error instanceof TypeError &&
    error.message === WEBKIT_MIXED_CONTENT_BLOCK_MESSAGE
  ) {
    return 'blocked'
  }
  return 'network'
}

function memoKey(baseUrl: string): string {
  return `${MEMO_KEY_PREFIX}${baseUrl}`
}

function readMemo(baseUrl: string): DaemonProbeResult | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(memoKey(baseUrl))
  } catch {
    return null
  }
  if (raw === null) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    const result = daemonProbeResultSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function writeMemo(baseUrl: string, result: DaemonProbeResult): void {
  try {
    sessionStorage.setItem(memoKey(baseUrl), JSON.stringify(result))
  } catch {
    // Contract: memoization is best-effort; a blocked/full sessionStorage
    // just means every call in the session re-probes.
  }
}

// One in-flight promise per base URL so rapid double-invocation (e.g. a
// user double-clicking the "Check for local daemon" affordance) never fires
// two overlapping network requests.
const inFlight = new Map<string, Promise<DaemonProbeResult>>()

async function runProbe(baseUrl: string, options: ProbeDaemonOptions): Promise<DaemonProbeResult> {
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onExternalAbort)
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const response = await options.fetch(`${baseUrl}/api/runtime/ping`, {
      signal: controller.signal,
    })
    if (!response.ok) {
      return { detected: false, reason: 'http-error' }
    }

    // json() throwing (200 with an HTML/garbage body — captive portal,
    // misconfigured proxy) must classify as 'malformed': the HTTP response
    // itself proves the transport path is reachable, so letting it fall to
    // the outer catch would misclassify it as a fetch-level failure and
    // wrongly downgrade the capability tier.
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { detected: false, reason: 'malformed' }
    }
    const parsed = daemonPingResponseSchema.safeParse(body)
    if (!parsed.success) {
      return { detected: false, reason: 'malformed' }
    }

    return { detected: true, instanceId: parsed.data.instanceId }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { detected: false, reason: 'timeout' }
    }
    return { detected: false, reason: classifyFetchRejection(error, options.pageOriginScheme) }
  } finally {
    clearTimeout(timeoutId)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * Probes a local daemon's unauthenticated ping endpoint. Never throws and
 * never logs — callers decide how (or whether) to surface a "not detected"
 * result to the user. At most one network attempt per session per base URL
 * unless `forceRecheck` is set (used by the user-invoked recheck
 * affordance).
 */
export async function probeDaemon(
  baseUrl: string,
  options: ProbeDaemonOptions,
): Promise<DaemonProbeResult> {
  if (!options.forceRecheck) {
    const memoized = readMemo(baseUrl)
    if (memoized) return memoized
  }

  const existing = inFlight.get(baseUrl)
  if (existing && !options.forceRecheck) return existing

  const probePromise = runProbe(baseUrl, options).then((result) => {
    writeMemo(baseUrl, result)
    inFlight.delete(baseUrl)
    return result
  })
  inFlight.set(baseUrl, probePromise)

  return probePromise
}
