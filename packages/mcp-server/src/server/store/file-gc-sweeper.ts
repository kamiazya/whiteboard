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
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { isMissingFileError } from '../../shared/errno.js'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay.js'
import { getLogger } from '../log.js'
import { workspaceDir, workspaceFilesDir, workspacesRoot } from '../tenant/data-layout.js'
import { validateWorkspaceId } from '../validators.js'
import { listWorkspaces } from './document-store.js'
import { purgeDanglingFiles } from './file-gc.js'
import { parseFileGcIntervalMs } from './storage-env.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import type { VersionStore } from './version-store.js'
import { FileVersionStore } from './version-store.js'

const log = getLogger('file-gc-sweeper')

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

// Env parsing is deliberately STRICTER than file-gc.ts's resolveGraceMs
// (which uses Number.parseInt and would silently accept "1x" as 1): only a
// bare non-negative base-10 integer string is accepted. Anything else falls
// back to the default rather than risking a mistyped env var arming a much
// shorter (or negative) sweep interval than intended.
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
  // One definition of the rule, in storage-env.ts, which startup also uses to
  // refuse a value it cannot understand. This fallback is therefore
  // unreachable in a started server and kept only so library and test callers
  // get a safe value rather than a throw.
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
 * This is enumeration, not the safety check. Containment is decided by
 * `isWorkspaceDirContained`, which `runPass` runs on every id immediately
 * before its purge — discovered and DB-listed alike — so checking it here
 * as well would only be a second copy that no outcome depends on.
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

type ContainmentCheck = 'missing' | 'safe' | 'unsafe'

// One lstat+realpath containment check, run on a workspace's top-level
// directory and on its files/ child (see isWorkspaceDirContained below).
// `treatNonDirectoryAsMissing` only applies to the files/ child: a files
// entry that exists but is not a directory can't be an escape vector
// (realpath of a regular file just resolves in place) and purgeDanglingFiles'
// own readdir() will fail loudly on it later, so there is nothing to fail
// closed over here.
async function checkSubpathContainment(
  workspaceId: string,
  targetPath: string,
  realDataDir: string,
  label: string,
  treatNonDirectoryAsMissing = false,
): Promise<ContainmentCheck> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(targetPath)
  } catch (err) {
    // Missing is not a containment risk -- purgeDanglingFiles() itself
    // handles a missing files dir by returning zero purged.
    if (isMissingFileError(err)) return 'missing'
    log.warning({ workspaceId, err }, `file-gc sweep: skipped workspace, could not stat ${label}`)
    return 'unsafe'
  }
  if (stats.isSymbolicLink()) {
    log.warning({ workspaceId }, `file-gc sweep: skipped workspace with symlinked ${label}`)
    return 'unsafe'
  }
  if (treatNonDirectoryAsMissing && !stats.isDirectory()) return 'missing'

  let realTargetPath: string
  try {
    realTargetPath = await realpath(targetPath)
  } catch (err) {
    log.warning(
      { workspaceId, err },
      `file-gc sweep: skipped workspace, could not resolve ${label} realpath`,
    )
    return 'unsafe'
  }
  if (realTargetPath !== realDataDir && !realTargetPath.startsWith(realDataDir + sep)) {
    log.warning({ workspaceId }, `file-gc sweep: skipped workspace ${label} escaping data dir`)
    return 'unsafe'
  }
  return 'safe'
}

// THE gate before every purge: whether a workspace's directory, and its
// files/ child, really resolve inside the data dir. purgeDanglingFiles() only
// joins <workspaceDir>/files lexically (assertPathWithinDir) and follows
// whatever that resolves to, so without this a purge could unlink through a
// symlink — at the workspace dir, at its files/ child, or at an ANCESTOR such
// as the workspaces root, which only realpath can see — into a directory
// outside the data dir. Neither source of ids is trusted: a DB row can
// outlive its directory being replaced by a symlink, and a directory found on
// disk can be re-pointed between discovery and its own turn.
async function isWorkspaceDirContained(scope: StoreScope, workspaceId: string): Promise<boolean> {
  const { dataDir } = scope
  const { tenantId } = scope.layout
  const entryPath = workspaceDir(dataDir, tenantId, workspaceId)

  let realDataDir: string
  try {
    realDataDir = await realpath(dataDir)
  } catch (err) {
    log.warning(
      { workspaceId, err },
      'file-gc sweep: skipped workspace, could not resolve data dir realpath',
    )
    return false
  }

  const dirCheck = await checkSubpathContainment(workspaceId, entryPath, realDataDir, 'dir')
  if (dirCheck === 'unsafe') return false
  if (dirCheck === 'missing') return true

  const filesPath = workspaceFilesDir(dataDir, tenantId, workspaceId)
  const filesCheck = await checkSubpathContainment(
    workspaceId,
    filesPath,
    realDataDir,
    'files dir',
    true,
  )
  return filesCheck !== 'unsafe'
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
 * then the DB's. Nothing here is a safety check — `runPass` gates each id on
 * containment immediately before purging it.
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
        // Containment is checked here, immediately before the destructive
        // call, and nowhere earlier: a pass over every workspace can take a
        // while (a full document scan each), so a check made while building
        // `ids` could be stale by this workspace's turn. This does not make
        // the check ATOMIC with purgeDanglingFiles' own readdir/unlink (that
        // would need directory-handle/no-follow semantics it does not have),
        // but it shrinks the exposure to this one iteration.
        //
        // `isWorkspaceDirContained` already logs the specific reason it
        // refused, so there is nothing more to log here.
        if (!(await isWorkspaceDirContained(scope, workspaceId))) continue
        await purge(workspaceId)
      } catch (err) {
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
