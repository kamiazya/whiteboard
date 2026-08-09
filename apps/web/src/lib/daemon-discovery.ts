/**
 * Local-daemon discovery over the daemons the user has actually named.
 *
 * There is deliberately NO port scan. The server binds dynamically — the
 * packaged daemon takes the first free port from 3099 upward, dev worktrees
 * use hash-derived ports — and the browser cannot read the daemon registry,
 * so any fixed range is a guess that is wrong in both directions: it misses
 * every daemon outside it while firing probes at ports nobody asked about.
 * Entering a port is the primary way in, and a remembered baseUrl is just a
 * port the user named on an earlier visit.
 *
 * A baseUrl is a HINT, not an identity: a port can be re-bound by a
 * different daemon between visits, so results carry the ping's instanceId
 * and callers must treat that (plus pairing, where it applies) as the
 * actual identity.
 */
import type { DaemonProbeResult, ProbeDaemonOptions } from './daemon-probe.js'
import { probeDaemon } from './daemon-probe.js'

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
  dismissed = [],
  explicit,
}: {
  remembered: readonly string[]
  /**
   * Daemons the user disconnected from. Excluded even when they fall inside
   * the scanned range — otherwise disconnecting from the daemon on the
   * default port would last exactly until the next page load.
   */
  dismissed?: readonly string[]
  /**
   * A daemon the user named by hand. It leads the list and overrides a
   * dismissal, because typing a port is an unambiguous request for that
   * daemon and there would otherwise be no way back from a disconnect.
   *
   * It is also the only way to reach a daemon outside the scanned range —
   * a dev worktree binds a hash-derived port, and a packaged daemon whose
   * first ten candidates are taken lands past the scan as well.
   */
  explicit?: string
}): string[] {
  const seen = new Set<string>()
  const candidates: string[] = []
  const blocked = new Set(dismissed.map(normalizeBaseUrl))
  const push = (baseUrl: string) => {
    const normalized = normalizeBaseUrl(baseUrl)
    if (seen.has(normalized) || blocked.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }
  if (explicit !== undefined) {
    const normalized = normalizeBaseUrl(explicit)
    blocked.delete(normalized)
    push(normalized)
  }
  for (const baseUrl of remembered) push(baseUrl)
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
