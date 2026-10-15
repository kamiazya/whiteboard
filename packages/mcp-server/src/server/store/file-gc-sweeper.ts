// Periodic background sweep of packages/mcp-server/src/server/store/file-gc.ts's
// purgeDanglingFiles across every workspace, so storage is reclaimed without an
// operator ever hitting the purge route by hand.
//
// Design: a completion-rescheduled ONE-SHOT setTimeout, unref'd — never
// setInterval. Unlike a store that piggybacks its lazy prune on a
// high-frequency operation it already runs, file-gc has no natural hook: a
// full pass (Loro fork+checkout per version per document, across every
// workspace) is too expensive to run inline on every mutation. A `setInterval`
// would also keep the daemon's event loop alive for the process lifetime even
// when idle; an unref'd one-shot timer that only reschedules itself once its
// own pass has settled does not.

import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissingFileError } from '../../shared/errno.js'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay.js'
import { getLogger } from '../log.js'
import { workspaceFilesDir, workspacesRoot } from '../tenant/data-layout.js'
import { validateWorkspaceId } from '../validators.js'
import { listWorkspaces } from './document-store.js'
import { FilesDirNotContainedError, purgeDanglingFiles } from './file-gc.js'
import { parseFileGcIntervalMs } from './storage-env.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import type { VersionStore } from './version-store.js'
import { FileVersionStore } from './version-store.js'

const log = getLogger('file-gc-sweeper')

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

function resolveIntervalMs(explicit: number | undefined): number {
  // Number.isFinite (not just typeof === 'number') also rejects NaN --
  // Math.max(0, NaN) and Math.min(NaN, MAX) both evaluate to NaN, and
  // scheduleNext()'s `intervalMs <= 0` guard does not short-circuit on NaN
  // (NaN <= 0 is false), so an unguarded NaN would arm setTimeout(fn, NaN),
  // which Node coerces to a ~1ms delay -- turning an intended disable/no-op
  // into a near-continuous full-workspace sweep.
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.min(Math.max(0, explicit), MAX_TIMER_DELAY_MS)
  }
  // One rule for the value, in storage-env.ts, and startup refuses a
  // malformed one (collectStorageEnvIssues), so a started server never
  // reaches the default below: it serves only library and test callers.
  const parsed = parseFileGcIntervalMs(process.env)
  if (parsed.ok && parsed.value !== null) return Math.min(parsed.value, MAX_TIMER_DELAY_MS)
  return DEFAULT_INTERVAL_MS
}

/**
 * Whether one entry under the workspaces root looks like a workspace, and its
 * id if so: a real (non-symlinked) directory, named by a valid id, with a
 * `files/` directory inside. A workspace named `blobs` is therefore not
 * confusable with the blob root, which lives elsewhere and has no `files/`.
 *
 * This is enumeration, not the safety check. Containment is decided inside
 * `purgeDanglingFiles`, under the workspace write barrier, for every id —
 * discovered and DB-listed alike — so checking it here as well would only be
 * a second copy that no outcome depends on.
 */
async function discoveredWorkspaceId(name: string, scope: StoreScope): Promise<string | null> {
  const { dataDir } = scope
  const { tenantId } = scope.layout
  try {
    const stats = await lstat(join(workspacesRoot(dataDir, tenantId), name))
    if (stats.isSymbolicLink()) {
      log.warning({ name }, 'file-gc sweep: skipped symlinked top-level entry')
      return null
    }
    if (!stats.isDirectory()) return null
    const workspaceId = validateWorkspaceId(name)
    const filesStat = await lstat(workspaceFilesDir(dataDir, tenantId, name))
    return filesStat.isDirectory() ? workspaceId : null
  } catch {
    return null
  }
}

async function discoverFsWorkspaces(scope: StoreScope): Promise<string[]> {
  const { dataDir } = scope
  let entries: Dirent<string>[]
  try {
    entries = await readdir(workspacesRoot(dataDir, scope.layout.tenantId), {
      withFileTypes: true,
      encoding: 'utf8',
    })
  } catch (err) {
    if (isMissingFileError(err)) return []
    throw err
  }

  const result: string[] = []
  for (const entry of entries) {
    const workspaceId = await discoveredWorkspaceId(entry.name, scope)
    if (workspaceId !== null) result.push(workspaceId)
  }
  return result
}

export interface FileGcSweeperOptions {
  // Overrides WHITEBOARD_FILE_GC_INTERVAL_MS / the 24h default. 0 disables
  // the sweeper entirely (tick() remains manually callable; start() arms
  // nothing).
  intervalMs?: number
  listWorkspaces?: () => Promise<{ workspaceId: string }[]>
  discoverFsWorkspaces?: () => Promise<string[]>
  purge?: (workspaceId: string) => Promise<unknown>
  /**
   * Which data directory this sweeper keeps clean. Omitted, the process's —
   * what the composition roots take, since each serves the keeper's one
   * directory.
   */
  scope?: StoreScope
  // FileVersionStore is stateless (no fields; every method re-reads the
  // filesystem under withWorkspaceWriteLock), so constructing one here is
  // semantically identical to routes/files.ts's instance over the same data
  // dir — no need to thread app.ts's shared instance through. Overridable
  // for tests. If VersionStore ever grows in-memory state, this assumption
  // needs revisiting.
  versionStore?: VersionStore
}

interface FileGcSweeperStopOptions {
  // Caps how long stop() waits for an in-flight pass before returning. A
  // full pass can be expensive (Loro fork+checkout per version per
  // document, across every workspace), and stop() is invoked from the daemon's
  // shutdown path (idle timeout, explicit shutdown route, normal close) --
  // without a cap, shutdown blocks for the entire remaining pass duration.
  // The in-flight pass itself is NOT cancelled: it keeps running in the
  // background and its own .finally() still fires (scheduleNext() is a
  // no-op once stopped=true), so leaving it to finish costs nothing beyond
  // the already-open workspace lock. Omit to wait unbounded (existing
  // behavior, still used by tests that need a real completion signal).
  timeoutMs?: number
}

export interface FileGcSweeper {
  start(): void
  // Runs one pass. Single-flight: a second call while a pass is in flight
  // returns the SAME in-flight promise rather than starting a second pass.
  // This is the exact function the timer callback invokes, exposed
  // explicitly as the concurrency-test seam — a completion-rescheduled
  // one-shot timer cannot be forced to overlap by timer advancement alone.
  tick(): Promise<void>
  stop(options?: FileGcSweeperStopOptions): Promise<void>
}

/**
 * Every workspace this pass should visit, in one set: those found on disk,
 * then the DB's. Nothing here is a safety check — the purge gates each id on
 * containment itself.
 */
async function workspacesToSweep(
  scope: StoreScope,
  options: Pick<FileGcSweeperOptions, 'listWorkspaces' | 'discoverFsWorkspaces'>,
): Promise<Set<string>> {
  const listWs = options.listWorkspaces ?? (() => listWorkspaces(scope))
  const discoverFs = options.discoverFsWorkspaces ?? (() => discoverFsWorkspaces(scope))
  const [dbWorkspaces, fsWorkspaces] = await Promise.all([listWs(), discoverFs()])
  return new Set([...fsWorkspaces, ...dbWorkspaces.map((w) => w.workspaceId)])
}

export function createFileGcSweeper(options: FileGcSweeperOptions = {}): FileGcSweeper {
  const intervalMs = resolveIntervalMs(options.intervalMs)
  const scope = options.scope ?? globalStoreScope
  const sweeperVersionStore = options.versionStore ?? new FileVersionStore(scope)
  const purge =
    options.purge ??
    ((workspaceId: string) =>
      purgeDanglingFiles(workspaceId, { versionStore: sweeperVersionStore, scope }))

  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let stopped = false

  async function runPass(): Promise<void> {
    const ids = await workspacesToSweep(scope, options)

    // Sequential, not parallel: purgeDanglingFiles holds a per-workspace
    // write lock and forks Loro docs internally, so running every workspace
    // concurrently would multiply peak memory and lock contention for no
    // benefit at a 24h-default cadence.
    for (const workspaceId of ids) {
      try {
        await purge(workspaceId)
      } catch (err) {
        // A containment refusal is a skip, not a failure: the purge already
        // logged the hop that escaped, and the next workspace still runs.
        if (err instanceof FilesDirNotContainedError) continue
        log.error({ workspaceId, err }, 'file-gc sweep failed for workspace')
      }
    }
  }

  function scheduleNext(): void {
    if (stopped || intervalMs <= 0) return
    timer = setTimeout(() => {
      timer = null
      void tick()
    }, intervalMs)
    // Do not keep the daemon process alive just to run a background sweep —
    // matches the unref pattern in document-store.ts's auto-compact debounce.
    timer.unref()
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (inFlight) return inFlight

    // The ENTIRE pass — discovery included — must be wrapped in this caught
    // promise. An escaped rejection here is an unhandled rejection that
    // would crash the daemon; catching only the per-workspace purge above is
    // not enough because listWorkspaces()/discoverFsWorkspaces() can also
    // reject.
    const pass = runPass()
      .catch((err) => {
        log.error({ err }, 'file-gc sweep pass failed before per-workspace iteration')
      })
      .finally(() => {
        inFlight = null
        scheduleNext()
      })
    inFlight = pass
    return pass
  }

  function start(): void {
    if (stopped || intervalMs <= 0) return
    scheduleNext()
  }

  async function stop(options: FileGcSweeperStopOptions = {}): Promise<void> {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!inFlight) return
    if (typeof options.timeoutMs !== 'number') {
      await inFlight
      return
    }
    // Hold the handle so it can be cleared once either side of the race
    // settles -- an unref'd timer still keeps its closure (and the resolve
    // it captures) alive until it fires, even though it can't block process
    // exit on its own.
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        inFlight,
        new Promise<void>((resolve) => {
          timeoutTimer = setTimeout(resolve, options.timeoutMs)
          timeoutTimer.unref()
        }),
      ])
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
    }
  }

  return { start, tick, stop }
}
