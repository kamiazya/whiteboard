import { z } from 'zod'

// Default loopback origin for the local daemon (matches
// packages/mcp-server's default runtime port). Callers that know a
// non-default port (settings.storage.localDaemonBaseUrl) pass it explicitly.
export const DEFAULT_DAEMON_BASE_URL = 'http://127.0.0.1:3099'

const DEFAULT_TIMEOUT_MS = 2000
const MEMO_KEY_PREFIX = 'whiteboard:daemon-probe:'

// Mirrors daemonPingResponseSchema in
// packages/mcp-server/src/shared/api-contracts/runtime.ts. That module is
// deliberately excluded from the published ./api-contracts barrel (it's
// server-runtime-only), so apps/web keeps its own copy rather than reaching
// into mcp-server internals at build time. A dedicated test cross-parses
// fixtures through both schemas to catch field-level drift.
const daemonPingResponseSchema = z.object({
  ok: z.literal(true),
  instanceId: z.string(),
})

export type DaemonProbeResult =
  | { detected: true; instanceId: string }
  | { detected: false; reason: 'timeout' | 'http-error' | 'malformed' | 'network' }

export interface ProbeDaemonOptions {
  fetch: typeof globalThis.fetch
  timeoutMs?: number
  forceRecheck?: boolean
  signal?: AbortSignal
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
    const result = z
      .union([
        z.object({ detected: z.literal(true), instanceId: z.string() }),
        z.object({
          detected: z.literal(false),
          reason: z.enum(['timeout', 'http-error', 'malformed', 'network']),
        }),
      ])
      .safeParse(parsed)
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

    const body: unknown = await response.json()
    const parsed = daemonPingResponseSchema.safeParse(body)
    if (!parsed.success) {
      return { detected: false, reason: 'malformed' }
    }

    return { detected: true, instanceId: parsed.data.instanceId }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { detected: false, reason: 'timeout' }
    }
    return { detected: false, reason: 'network' }
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
