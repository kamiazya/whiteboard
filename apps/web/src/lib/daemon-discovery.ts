/**
 * Local-daemon discovery over a bounded candidate set.
 *
 * The server side already binds dynamically: the packaged daemon takes the
 * first free port from 3099 upward (ensure-daemon's findAvailablePort) and
 * dev worktree daemons run on hash-derived ports. The browser cannot read
 * the daemon registry file, so discovery is limited to two channels:
 * previously remembered baseUrls (localStorage, most recent first) and a
 * small scan of the default port range. Everything is probed in parallel
 * with the same timeboxed ping used by the single-probe path.
 *
 * A baseUrl is a HINT, not an identity: a port can be re-bound by a
 * different daemon between visits, so results carry the ping's instanceId
 * and callers must treat that (plus pairing, where it applies) as the
 * actual identity.
 */
import type { DaemonProbeResult, ProbeDaemonOptions } from './daemon-probe.js'
import { probeDaemon } from './daemon-probe.js'

const DEFAULT_PORT_RANGE_START = 3099
// findAvailablePort drift rarely goes far; a bounded scan keeps a manual
// check under ~1s worst-case (probes run in parallel, each timeboxed).
const DEFAULT_PORT_RANGE_COUNT = 10
const MAX_REMEMBERED_DAEMONS = 5

export interface DiscoveredDaemon {
  readonly baseUrl: string
  readonly instanceId: string
}

export interface DiscoveryOutcome {
  readonly found: DiscoveredDaemon[]
  /** Failure results for candidates that answered nothing usable — kept so
   *  callers can still derive the proven-blocked capability tier. */
  readonly failures: DaemonProbeResult[]
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export function candidateBaseUrls({
  remembered,
  portRangeStart = DEFAULT_PORT_RANGE_START,
  portRangeCount = DEFAULT_PORT_RANGE_COUNT,
}: {
  remembered: readonly string[]
  portRangeStart?: number
  portRangeCount?: number
}): string[] {
  const seen = new Set<string>()
  const candidates: string[] = []
  const push = (baseUrl: string) => {
    const normalized = normalizeBaseUrl(baseUrl)
    if (seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }
  for (const baseUrl of remembered) push(baseUrl)
  for (let i = 0; i < portRangeCount; i++) push(`http://127.0.0.1:${portRangeStart + i}`)
  return candidates
}

export async function discoverDaemons({
  candidates,
  fetch,
  pageOriginScheme,
  probeFn = probeDaemon,
  forceRecheck,
  signal,
}: {
  candidates: readonly string[]
  fetch: typeof globalThis.fetch
  pageOriginScheme: 'http' | 'https'
  probeFn?: (baseUrl: string, options: ProbeDaemonOptions) => Promise<DaemonProbeResult>
  forceRecheck?: boolean
  signal?: AbortSignal
}): Promise<DiscoveryOutcome> {
  const results = await Promise.all(
    candidates.map(async (baseUrl) => {
      try {
        const result = await probeFn(baseUrl, {
          fetch,
          pageOriginScheme,
          forceRecheck,
          signal,
        })
        return { baseUrl, result }
      } catch {
        // A single candidate failing hard must not sink the whole sweep.
        return { baseUrl, result: null }
      }
    }),
  )
  const byInstance = new Map<string, DiscoveredDaemon>()
  const failures: DaemonProbeResult[] = []
  for (const { baseUrl, result } of results) {
    if (!result?.detected) {
      if (result) failures.push(result)
      continue
    }
    // First candidate wins per instance: remembered URLs precede the scan,
    // so a daemon reachable under both keeps its remembered spelling.
    if (!byInstance.has(result.instanceId)) {
      byInstance.set(result.instanceId, { baseUrl, instanceId: result.instanceId })
    }
  }
  return { found: [...byInstance.values()], failures }
}

/** MRU update for the persisted known-daemon list. */
export function rememberKnownDaemon(known: readonly string[], baseUrl: string): string[] {
  const normalized = normalizeBaseUrl(baseUrl)
  const rest = known.map(normalizeBaseUrl).filter((entry) => entry !== normalized)
  return [normalized, ...rest].slice(0, MAX_REMEMBERED_DAEMONS)
}
