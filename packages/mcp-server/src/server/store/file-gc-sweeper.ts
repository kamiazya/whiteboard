// Periodic background sweep of packages/mcp-server/src/server/store/file-gc.ts's
// purgeDanglingFiles across every workspace, so storage is reclaimed without an
// operator ever hitting the purge route by hand.
//
// Design: a completion-rescheduled ONE-SHOT setTimeout, unref'd — never
// setInterval. Unlike ws-ticket-store.ts / oauth-authz-transactions.ts (which
// piggyback their lazy prune on a high-frequency operation they already run —
// minting a ticket/transaction), file-gc has no equivalent natural hook: a
// full pass (Loro fork+checkout per branch/version per canvas, across every
// workspace) is too expensive to run inline on every mutation. A `setInterval`
// would also keep the daemon's event loop alive for the process lifetime even
// when idle; an unref'd one-shot timer that only reschedules itself once its
// own pass has settled does not.

import type { Dirent } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import { validateWorkspaceId } from '../validators.js'
import { listWorkspaces } from './canvas-store.js'
import { isMissingFileError } from './corrupt-stored-data.js'
import { purgeDanglingFiles } from './file-gc.js'
import type { VersionStore } from './version-store.js'
import { FileVersionStore } from './version-store.js'

const log = getLogger('file-gc-sweeper')

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

// setTimeout() only supports delays up to a signed 32-bit int; Node silently
// truncates anything larger to 1ms (with a TimeoutOverflowWarning), which
// would turn an intended "run monthly" interval into a near-continuous
// full-workspace scan. Clamp instead of trusting every safe integer through.
const MAX_TIMER_DELAY_MS = 2_147_483_647

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
  const raw = process.env.WHITEBOARD_FILE_GC_INTERVAL_MS
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const parsed = Number(raw)
    if (Number.isSafeInteger(parsed)) return Math.min(parsed, MAX_TIMER_DELAY_MS)
  }
  return DEFAULT_INTERVAL_MS
}

async function discoverFsWorkspaces(): Promise<string[]> {
  const dataDir = getDataDir()
  let entries: Dirent<string>[]
  try {
    entries = await readdir(dataDir, { withFileTypes: true, encoding: 'utf8' })
  } catch (err) {
    if (isMissingFileError(err)) return []
    throw err
  }

  let realDataDir: string
  try {
    realDataDir = await realpath(dataDir)
  } catch {
    return []
  }

  const result: string[] = []
  for (const entry of entries) {
    const name = entry.name
    const entryPath = join(dataDir, name)

    // lstat BEFORE any further inspection: a symlinked top-level entry could
    // point outside the data dir entirely, and discovery feeds a destructive
    // unlink pass downstream, so this is a TOCTOU-sensitive choke point, not
    // a cosmetic check.
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(entryPath)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) {
      log.warning({ name }, 'file-gc sweep: skipped symlinked top-level entry')
      continue
    }
    if (!stats.isDirectory()) continue

    let workspaceId: string
    try {
      workspaceId = validateWorkspaceId(name)
    } catch {
      continue
    }

    // Lexical containment (assertPathWithinDir) is insufficient here: it
    // cannot see through a symlink further down the tree. realpath resolves
    // the actual target so a directory that *looks* like a plain workspace
    // dir but ultimately resolves outside dataDir is still caught.
    let realEntryPath: string
    try {
      realEntryPath = await realpath(entryPath)
    } catch {
      continue
    }
    if (realEntryPath !== realDataDir && !realEntryPath.startsWith(realDataDir + sep)) {
      log.warning({ workspaceId }, 'file-gc sweep: skipped workspace dir escaping data dir')
      continue
    }

    // 'blobs' is a valid workspace id (validateWorkspaceId permits it) and
    // canvas-store.ts also uses <dataDir>/blobs as the snapshot root
    // (<dataDir>/blobs/<workspaceId>/canvas/...), so this directory serves
    // double duty. The snapshot layout has no files/ child of its own, so
    // this containment check alone already tells the two apart: only an
    // upload-only workspace literally named 'blobs' — which the upload
    // route would have written to <dataDir>/blobs/files — passes here.
    try {
      const filesStat = await lstat(join(entryPath, 'files'))
      if (!filesStat.isDirectory()) continue
    } catch {
      continue
    }

    result.push(workspaceId)
  }
  return result
}

type ContainmentCheck = 'missing' | 'safe' | 'unsafe'

// Shared lstat+realpath containment check used for both a DB workspace's
// top-level directory and its files/ child (see isDbWorkspaceDirSafe below).
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
    log.warning(
      { workspaceId, err },
      `file-gc sweep: skipped DB workspace, could not stat ${label}`,
    )
    return 'unsafe'
  }
  if (stats.isSymbolicLink()) {
    log.warning({ workspaceId }, `file-gc sweep: skipped DB workspace with symlinked ${label}`)
    return 'unsafe'
  }
  if (treatNonDirectoryAsMissing && !stats.isDirectory()) return 'missing'

  let realTargetPath: string
  try {
    realTargetPath = await realpath(targetPath)
  } catch (err) {
    log.warning(
      { workspaceId, err },
      `file-gc sweep: skipped DB workspace, could not resolve ${label} realpath`,
    )
    return 'unsafe'
  }
  if (realTargetPath !== realDataDir && !realTargetPath.startsWith(realDataDir + sep)) {
    log.warning({ workspaceId }, `file-gc sweep: skipped DB workspace ${label} escaping data dir`)
    return 'unsafe'
  }
  return 'safe'
}

// DB-listed workspaces are trusted less than they look: a workspace row can
// exist while its on-disk directory has since been replaced by a symlink (or
// never matched the DB row's containment at all). discoverFsWorkspaces()
// applies this same lstat+realpath containment check to every workspace it
// discovers from the filesystem, but a DB row bypasses that discovery path
// entirely -- without this check runPass() would purge through a symlinked
// dir straight into purgeDanglingFiles(), which only does lexical
// containment (assertPathWithinDir) and cannot see through a symlink.
//
// The top-level workspace dir passing containment is not enough on its own:
// purgeDanglingFiles() only lexically joins <workspaceDir>/files and follows
// whatever that resolves to, so a workspace dir that is itself safe can still
// have its files/ CHILD replaced by a symlink escaping the data dir. A
// filesystem-discovered workspace never reaches purge with such a files/ dir
// (discoverFsWorkspaces()'s lstat().isDirectory() check is false for a
// symlink), so a DB-listed workspace needs the same files/ subpath check.
async function isDbWorkspaceDirSafe(workspaceId: string): Promise<boolean> {
  const dataDir = getDataDir()
  const entryPath = join(dataDir, workspaceId)

  let realDataDir: string
  try {
    realDataDir = await realpath(dataDir)
  } catch (err) {
    log.warning(
      { workspaceId, err },
      'file-gc sweep: skipped DB workspace, could not resolve data dir realpath',
    )
    return false
  }

  const dirCheck = await checkSubpathContainment(workspaceId, entryPath, realDataDir, 'dir')
  if (dirCheck === 'unsafe') return false
  if (dirCheck === 'missing') return true

  const filesPath = join(entryPath, 'files')
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
  // FileVersionStore is stateless (no fields; every method re-reads the
  // filesystem under withWorkspaceWriteLock), so constructing one here is
  // semantically identical to routes/files.ts's instance over the same data
  // dir — no need to thread app.ts's shared instance through. Overridable
  // for tests. If VersionStore ever grows in-memory state, this assumption
  // needs revisiting.
  versionStore?: VersionStore
}

export interface FileGcSweeperStopOptions {
  // Caps how long stop() waits for an in-flight pass before returning. A
  // full pass can be expensive (Loro fork+checkout per branch/version per
  // canvas, across every workspace), and stop() is invoked from the daemon's
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

export function createFileGcSweeper(options: FileGcSweeperOptions = {}): FileGcSweeper {
  const intervalMs = resolveIntervalMs(options.intervalMs)
  const sweeperVersionStore = options.versionStore ?? new FileVersionStore()
  const listWs = options.listWorkspaces ?? listWorkspaces
  const discoverFs = options.discoverFsWorkspaces ?? discoverFsWorkspaces
  const purge =
    options.purge ??
    ((workspaceId: string) =>
      purgeDanglingFiles(workspaceId, { versionStore: sweeperVersionStore }))

  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let stopped = false

  async function runPass(): Promise<void> {
    const [dbWorkspaces, fsWorkspaces] = await Promise.all([listWs(), discoverFs()])
    const ids = new Set<string>()
    for (const id of fsWorkspaces) ids.add(id)
    // fsWorkspaces already passed containment checks inside discoverFs();
    // a DB row has not, so it gets its own check before joining the set.
    for (const w of dbWorkspaces) {
      if (ids.has(w.workspaceId)) continue
      if (await isDbWorkspaceDirSafe(w.workspaceId)) ids.add(w.workspaceId)
    }

    // Sequential, not parallel: purgeDanglingFiles holds a per-workspace
    // write lock and forks Loro docs internally, so running every workspace
    // concurrently would multiply peak memory and lock contention for no
    // benefit at a 24h-default cadence.
    for (const workspaceId of ids) {
      try {
        // Revalidate containment again, immediately before the destructive
        // call, rather than trusting the check done once above while
        // building `ids`. A pass over every workspace can take a while (a
        // full canvas scan per workspace), and re-running the check here
        // narrows the window in which a workspace dir (or its files/
        // child) could have been swapped for a symlink between discovery
        // and this specific workspace's purge -- for BOTH fs-discovered and
        // DB-listed ids, since either could still be re-pointed after its
        // one-time check above. This does not make the check atomic with
        // purgeDanglingFiles' own readdir/unlink (that would need
        // directory-handle/no-follow semantics purgeDanglingFiles does not
        // have), but it meaningfully shrinks the exposure from "the whole
        // pass" to "this one iteration".
        // isDbWorkspaceDirSafe() already logs the specific reason (symlinked
        // dir, symlinked files/ child, unresolvable realpath, ...) when it
        // returns false, so there is nothing more to log here beyond
        // skipping the purge.
        if (!(await isDbWorkspaceDirSafe(workspaceId))) continue
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
    // matches the unref pattern in canvas-store.ts's auto-compact debounce.
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
