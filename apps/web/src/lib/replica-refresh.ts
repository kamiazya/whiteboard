/**
 * ADR-0023 decision 5's arrival path: working on a daemon workspace quietly
 * refreshes this browser's replica of it, so a later load with the daemon
 * unreachable has something honest to read. Deduped while the registry
 * entry is FRESH (within `REPLICA_STALE_AFTER_MS`) rather than forever per
 * session: a long working session would otherwise let its replica age all
 * day with no recourse. The pull still only fires on a workspace resolve —
 * no timer loop — and is scheduled off the critical path (idle callback,
 * with a timer fallback where the API is absent). A failed pull writes no
 * registry entry, so the next resolve simply tries again.
 *
 * Best-effort throughout: a background cache that fails must cost the page
 * nothing, so every failure path ends in silence and the registry simply
 * keeps its previous claim.
 */
// Static on purpose: the only static consumer of this module is the daemon
// page, which already imports daemon-api-client itself — while a dynamic
// import here charges the whole schema graph's first load to whatever
// timeout happens to be waiting (the in-body-await-import flake shape).
import { bytesToBase64, messageOf } from '@kamiazya/whiteboard-model'
import { getAppLogger } from './app-logger.js'
import { listWorkspaces } from './daemon-api-client.js'
import { findReplicaForHandle, withReplicaEntry } from './replicas.js'
import { createUserSettingsStore } from './user-settings-store.js'

const log = getAppLogger('replica-refresh')

/** The cancel for a schedule that was deduped away, so has nothing to stop. */
const noop = (): void => {}

/**
 * How old a replica may grow before a workspace resolve pulls again. The
 * cost of a re-fire is one snapshot GET + import + save — the same pull the
 * page already pays once per visit — and it fires at most once per resolve,
 * so the ceiling is visits, never a timer loop.
 */
const REPLICA_STALE_AFTER_MS = 15 * 60 * 1000

const refreshed = new Set<string>()
// Pulls in flight: a second resolve while one is pending must not double
// the request — the freshness check cannot see a pull that has not written
// its registry entry yet.
const pending = new Set<string>()

/** A fresh registry entry for this daemon+handle — the dedupe may hold. */
function hasFreshEntry(deps: ReplicaRefreshDeps): boolean {
  const match = findReplicaForHandle(createUserSettingsStore().load(), deps.workspaceId)
  if (match === null || match.daemonBaseUrl !== deps.daemonBaseUrl) return false
  const at = Date.parse(match.syncedAt)
  return Number.isFinite(at) && Date.now() - at <= REPLICA_STALE_AFTER_MS
}

export interface ReplicaRefreshDeps {
  fetch: typeof globalThis.fetch
  daemonBaseUrl: string
  workspaceId: string
  /** Test seam; production uses requestIdleCallback (setTimeout fallback). */
  schedule?: (run: () => void) => void
  /** Test seam for the pull; production lazy-loads replica-cache. */
  cache?: typeof import('./replica-cache.js').cacheDaemonWorkspace
}

/**
 * Background best-effort: the page owes nothing to a failed cache — but a
 * silent catch is also why a pull that never happened went unnoticed for as
 * long as it did, so a failure still leaves a trace. Never the fetch, the
 * deps object, or a token: only what names the pull.
 */
function reportRefreshFailure(deps: ReplicaRefreshDeps, err: unknown): void {
  log.warn('replica refresh failed', {
    daemonBaseUrl: deps.daemonBaseUrl,
    workspaceId: deps.workspaceId,
    name: err instanceof Error ? err.name : typeof err,
    message: messageOf(err, String(err)),
  })
}

function reportNoPull(
  daemonBaseUrl: string,
  workspaceId: string,
  result: { kind: string; reason?: unknown },
): void {
  log.warn('replica refresh did not pull', {
    daemonBaseUrl,
    workspaceId,
    kind: result.kind,
    ...(result.kind === 'failed' ? { reason: result.reason } : {}),
  })
}

/**
 * Schedule `body` off the critical path and answer a CANCEL for it. Call the
 * cancel when whatever asked for the work is gone: until it existed nothing
 * could stop a run scheduled onto an idle callback or a 1.5s timer, so a
 * caller that unmounted first left it armed, to fire against a world that had
 * moved on. In a test run that is a warning charged to whichever case happens
 * to be executing a second and a half later, which reads as that case's
 * failure and is not (`issues/replica-refresh-warning-lands-on-a-later-test`).
 *
 * Cancelling once the body has begun is a no-op — it is left to its own
 * `finally`. Before, `release` runs: work that never started is not work that
 * already happened, so the dedupe that claimed it has to let go.
 */
function scheduleCancellable(
  schedule: (run: () => void) => void,
  body: () => Promise<void>,
  release: () => void,
): () => void {
  let cancelled = false
  let started = false
  schedule(() => {
    if (cancelled) return
    started = true
    void body()
  })
  return () => {
    if (started) return
    cancelled = true
    release()
  }
}

/**
 * `requestIdleCallback` alone has no bound: a page kept continuously busy (a
 * live document sync, a test harness's own response logging) can leave it
 * waiting well past what a background cache owes anyone. A `timeout` is a real
 * deadline — Chromium runs the callback anyway once it elapses, same as the
 * `setTimeout` fallback for an engine without the API at all.
 */
function idleSchedule(options?: IdleRequestOptions): (run: () => void) => void {
  return (run) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => run(), options)
    else setTimeout(run, 1500)
  }
}

/** The pull itself, once its slot comes up. Releases the in-flight claim. */
async function pullReplica(deps: ReplicaRefreshDeps, key: string): Promise<void> {
  try {
    // Resolve the page's handle to the CANONICAL workspace id before caching.
    // ADR-0019 gives a workspace two names, and the page often carries the
    // segment while the switcher rows carry the id — a registry keyed by
    // whichever the page had matches nothing. Measured in a real browser
    // before this resolve existed.
    const { workspaces } = await listWorkspaces(deps.fetch, deps.daemonBaseUrl)
    const summary = workspaces.find(
      (ws) => ws.workspaceId === deps.workspaceId || ws.segment === deps.workspaceId,
    )
    if (summary === undefined) return
    const canonical = summary.workspaceId
    const cache = deps.cache ?? (await import('./replica-cache.js')).cacheDaemonWorkspace
    const { BrowserWorkspaceDocs } = await import('./browser-workspace-docs.js')
    const result = await cache({
      fetch: deps.fetch,
      daemonBaseUrl: deps.daemonBaseUrl,
      workspaceId: canonical,
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    if (result.kind !== 'ok') {
      reportNoPull(deps.daemonBaseUrl, canonical, result)
      return
    }
    createUserSettingsStore().update((current) =>
      withReplicaEntry(current, canonical, {
        daemonBaseUrl: deps.daemonBaseUrl,
        syncedAt: result.syncedAt,
        syncedFrontier: result.syncedFrontier,
        // Captured for OFFLINE lookup: a URL usually carries the segment, and
        // offline is when it cannot be resolved.
        ...(summary.segment === undefined ? {} : { segment: summary.segment }),
        ...(summary.displayName === undefined ? {} : { displayName: summary.displayName }),
      }),
    )
  } catch (err) {
    reportRefreshFailure(deps, err)
  } finally {
    pending.delete(key)
  }
}

/** Returns a CANCEL — see `scheduleCancellable` for what it is for. */
export function scheduleReplicaRefresh(deps: ReplicaRefreshDeps): () => void {
  const key = `${deps.daemonBaseUrl} ${deps.workspaceId}`
  if (pending.has(key)) return noop
  if (refreshed.has(key) && hasFreshEntry(deps)) return noop
  refreshed.add(key)
  pending.add(key)
  return scheduleCancellable(
    deps.schedule ?? idleSchedule({ timeout: 2000 }),
    () => pullReplica(deps, key),
    () => {
      pending.delete(key)
      refreshed.delete(key)
    },
  )
}

export interface ReplicaPushDeps {
  fetch: typeof globalThis.fetch
  daemonBaseUrl: string
  /** Whatever the page's address carries — segment or canonical id. */
  workspaceId: string
  /** Test seam; production uses requestIdleCallback (setTimeout fallback). */
  schedule?: (run: () => void) => void
  /** Test seam; production reads the stored frontier through openDocumentStore. */
  readStoredFrontier?: (workspaceId: string) => Promise<string | null>
  /** Test seam for the ship; production lazy-loads replica-push. */
  push?: typeof import('./replica-push.js').pushReplicaEdits
}

const pushing = new Set<string>()

/**
 * Ship a replica's offline edits back to its keeper, if there are any —
 * ADR-0023 decision 3's return half. Callable on every daemon resolve:
 * the dirty pre-check is one loro-free IndexedDB read (the stored frontier
 * bytes against the registry's `syncedFrontier` claim), so a clean replica
 * costs no network and no loro chunk. An entry with NO recorded frontier
 * always ships (one full-snapshot merge, after which the frontier exists).
 * No session dedupe on purpose — cleanliness IS the dedupe, and a failed
 * ship retries on the next resolve.
 */
export function scheduleReplicaPush(deps: ReplicaPushDeps): () => void {
  const key = `${deps.daemonBaseUrl}\u0000${deps.workspaceId}`
  if (pushing.has(key)) return noop
  pushing.add(key)
  return scheduleCancellable(
    deps.schedule ?? idleSchedule(),
    async () => {
      try {
        const settings = createUserSettingsStore().load()
        const match = findReplicaForHandle(settings, deps.workspaceId)
        if (match === null || match.daemonBaseUrl !== deps.daemonBaseUrl) return
        const readStoredFrontier = deps.readStoredFrontier ?? readStoredFrontierFromIdb
        const stored = await readStoredFrontier(match.workspaceId)
        if (stored !== null && stored === match.syncedFrontier) return
        const push = deps.push ?? (await import('./replica-push.js')).pushReplicaEdits
        const { BrowserWorkspaceDocs } = await import('./browser-workspace-docs.js')
        const result = await push({
          fetch: deps.fetch,
          daemonBaseUrl: deps.daemonBaseUrl,
          workspaceId: match.workspaceId,
          workspaceDocs: new BrowserWorkspaceDocs(),
          ...(match.syncedFrontier === undefined ? {} : { syncedFrontier: match.syncedFrontier }),
        })
        if (result.kind !== 'ok') return
        createUserSettingsStore().update((current) =>
          withReplicaEntry(current, match.workspaceId, {
            daemonBaseUrl: deps.daemonBaseUrl,
            syncedAt: result.syncedAt,
            syncedFrontier: result.syncedFrontier,
          }),
        )
      } catch {
        // Background best-effort: the page owes nothing to a failed ship.
      } finally {
        pushing.delete(key)
      }
    },
    () => {
      pushing.delete(key)
    },
  )
}

async function readStoredFrontierFromIdb(workspaceId: string): Promise<string | null> {
  const { openDocumentStore } = await import('./replica-store.js')
  const stored = await openDocumentStore().readFrontier({
    docRef: { kind: 'workspace-tree', workspaceId },
  })
  if (stored === null) return null
  return bytesToBase64(stored.frontier)
}

/** Test seam: forget which workspaces this session already refreshed. */
export function resetReplicaRefreshForTests(): void {
  refreshed.clear()
  pending.clear()
  pushing.clear()
}
