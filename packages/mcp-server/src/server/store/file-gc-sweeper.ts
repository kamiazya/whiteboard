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

// Env parsing is deliberately STRICTER than file-gc.ts's resolveGraceMs
// (which uses Number.parseInt and would silently accept "1x" as 1): only a
// bare non-negative base-10 integer string is accepted. Anything else falls
// back to the default rather than risking a mistyped env var arming a much
// shorter (or negative) sweep interval than intended.
function resolveIntervalMs(explicit: number | undefined): number {
  if (typeof explicit === 'number') return Math.max(0, explicit)
  const raw = process.env.WHITEBOARD_FILE_GC_INTERVAL_MS
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const parsed = Number(raw)
    if (Number.isSafeInteger(parsed)) return parsed
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
    // Canvas snapshots live under <dataDir>/blobs/, not a workspace dir —
    // never treat it as one.
    if (name === 'blobs') continue

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

export interface FileGcSweeper {
  start(): void
  // Runs one pass. Single-flight: a second call while a pass is in flight
  // returns the SAME in-flight promise rather than starting a second pass.
  // This is the exact function the timer callback invokes, exposed
  // explicitly as the concurrency-test seam — a completion-rescheduled
  // one-shot timer cannot be forced to overlap by timer advancement alone.
  tick(): Promise<void>
  stop(): Promise<void>
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
    for (const w of dbWorkspaces) ids.add(w.workspaceId)
    for (const id of fsWorkspaces) ids.add(id)

    // Sequential, not parallel: purgeDanglingFiles holds a per-workspace
    // write lock and forks Loro docs internally, so running every workspace
    // concurrently would multiply peak memory and lock contention for no
    // benefit at a 24h-default cadence.
    for (const workspaceId of ids) {
      try {
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

  async function stop(): Promise<void> {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (inFlight) await inFlight
  }

  return { start, tick, stop }
}
