import { lstat, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { basename, extname, join, sep } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { purgeResultSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  DEFAULT_FILE_GRACE_MS,
  type FileReferenceReads,
  scanFileReferences,
  type UnjudgedFileHolder,
} from '@kamiazya/whiteboard-loro-adapter'
import type { z } from 'zod'
import { isMissingFileError } from '../../shared/errno.js'
import { getLogger } from '../log.js'
import { workspaceDir } from '../tenant/data-layout.js'
import { validateWorkspaceId } from '../validators.js'
import { daemonBlobStore } from './backup-guarded-blob-store.js'
import { backupIsInProgress } from './backup-in-progress.js'
import { catchUpWorkspaceDoc, openWorkspaceDocIfStored } from './document-store.js'
import { assertPathWithinDir } from './path-guard.js'
import { parseFileGcGraceMs } from './storage-env.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import type { VersionStore } from './version-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

// Garbage-collect files in a workspace's files directory that no document
// uses. Used means referenced by a live document, a trashed one (a restore
// brings it back under the same id) or a saved version of either. The
// version store is required: a pass without it would delete what a version
// restore brings back, and walking it costs one Loro fork+checkout per
// version.
//
// A scan that cannot read something it must judge (a version, a trash entry,
// a workspace node this build does not understand) refuses to purge rather
// than read the absence as "unused".

const log = getLogger('file-gc')

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

// Single source of truth for the wire shape is purgeResultSchema
// (daemon-client's api-contracts/document.ts) — both routes/files.ts's response and
// this internal return type derive from it so they cannot drift apart.
export type PurgeFilesResult = z.infer<typeof purgeResultSchema>

export class FilesDirNotContainedError extends Error {
  constructor(public readonly workspaceId: string) {
    super(
      `file-gc: refusing to purge ${workspaceId} because its files directory does not resolve inside the data directory`,
    )
    this.name = 'FilesDirNotContainedError'
  }
}

// Structured response body for the purge-dangling route, beside the error for
// the same reason as `incompleteFileGcScanErrorBody` below.
export function filesDirNotContainedErrorBody(
  error: unknown,
): { error: 'files_dir_not_contained'; message: string } | null {
  if (!(error instanceof FilesDirNotContainedError)) return null
  return { error: 'files_dir_not_contained', message: error.message }
}

type ContainmentCheck = 'missing' | 'safe' | 'unsafe'

// One lstat+realpath containment check, run on a workspace's top-level
// directory and on its files/ child (see isWorkspaceDirContained below).
// `treatNonDirectoryAsMissing` only applies to the files/ child: a files
// entry that exists but is not a directory can't be an escape vector
// (realpath of a regular file just resolves in place) and the purge's own
// readdir() fails loudly on it, so there is nothing to fail closed over here.
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
    // Missing is not a containment risk: the purge answers zero purged for a
    // missing files dir.
    if (isMissingFileError(err)) return 'missing'
    log.warning({ workspaceId, err }, `purge refused: could not stat ${label}`)
    return 'unsafe'
  }
  if (stats.isSymbolicLink()) {
    log.warning({ workspaceId }, `purge refused: symlinked ${label}`)
    return 'unsafe'
  }
  if (treatNonDirectoryAsMissing && !stats.isDirectory()) return 'missing'

  let realTargetPath: string
  try {
    realTargetPath = await realpath(targetPath)
  } catch (err) {
    log.warning({ workspaceId, err }, `purge refused: could not resolve ${label} realpath`)
    return 'unsafe'
  }
  if (realTargetPath !== realDataDir && !realTargetPath.startsWith(realDataDir + sep)) {
    log.warning({ workspaceId }, `purge refused: ${label} escapes the data dir`)
    return 'unsafe'
  }
  return 'safe'
}

// Whether a workspace's directory, and its files/ child, really resolve inside
// the data dir. The files dir is joined lexically (assertPathWithinDir) and
// readdir/unlink follow whatever that resolves to, so without this a purge
// could unlink through a symlink — at the workspace dir, at its files/ child,
// or at an ANCESTOR such as the workspaces root, which only realpath can see —
// into a directory outside the data dir. No source of a workspace id is
// trusted: a DB row can outlive its directory being replaced by a symlink, and
// a directory found on disk can be re-pointed after it was found.
async function isWorkspaceDirContained(scope: StoreScope, workspaceId: string): Promise<boolean> {
  let realDataDir: string
  try {
    realDataDir = await realpath(scope.dataDir)
  } catch (err) {
    log.warning({ workspaceId, err }, 'purge refused: could not resolve data dir realpath')
    return false
  }
  const entryPath = workspaceDir(scope.dataDir, scope.layout.tenantId, workspaceId)
  const dirCheck = await checkSubpathContainment(workspaceId, entryPath, realDataDir, 'dir')
  if (dirCheck !== 'safe') return dirCheck === 'missing'

  const filesPath = scope.layout.workspaceFilesDir(workspaceId)
  const filesCheck = await checkSubpathContainment(
    workspaceId,
    filesPath,
    realDataDir,
    'files dir',
    true,
  )
  return filesCheck !== 'unsafe'
}

/**
 * The files dir a purge may list and unlink in, or a refusal. Every caller of
 * the purge — the periodic sweeper and the Storage card's route alike — gets
 * the containment gate by reaching the files dir only through here, under the
 * write barrier, so no caller can skip it. The purge asks twice: before the
 * listing, and again after the reference scan — the pass's longest step —
 * immediately before the unlinks.
 *
 * This is not ATOMIC with the unlinks: that would need directory-handle,
 * no-follow semantics the fs API does not offer. The second check shrinks the
 * window to the span between it and the unlinks; it does not close it, and
 * the write barrier does not stop a filesystem re-point.
 */
async function containedFilesDir(scope: StoreScope, workspaceId: string): Promise<string> {
  validateWorkspaceId(workspaceId)
  const dir = assertPathWithinDir(
    scope.layout.workspaceFilesDir(workspaceId),
    scope.dataDir,
    'files dir',
  )
  if (!(await isWorkspaceDirContained(scope, workspaceId))) {
    throw new FilesDirNotContainedError(workspaceId)
  }
  return dir
}

export class IncompleteFileGcScanError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly skipped: ReadonlyArray<UnjudgedFileHolder>,
  ) {
    super(
      `file-gc: refusing to purge ${workspaceId} because ${skipped.length} target(s) could not be inspected`,
    )
    this.name = 'IncompleteFileGcScanError'
  }
}

function isIncompleteFileGcScanError(error: unknown): error is IncompleteFileGcScanError {
  return error instanceof IncompleteFileGcScanError
}

// Structured response body for the purge-dangling route. Kept next to the
// error class so every caller maps the same fail-closed condition to the
// same wire shape instead of letting it fall through to Hono's generic
// unstructured 500.
export function incompleteFileGcScanErrorBody(
  error: unknown,
): { error: 'incomplete_file_gc_scan'; message: string } | null {
  if (!isIncompleteFileGcScanError(error)) return null
  return { error: 'incomplete_file_gc_scan', message: error.message }
}

/**
 * Every fileId any state of this workspace still points at — live documents,
 * trashed ones and saved versions, judged by `scanFileReferences`, the
 * definition the browser keeper's sweep shares. This side supplies the
 * reads: the stored record, the trash bytes in the blob directory, and the
 * version store.
 *
 * **The `yieldToLoop()` between units is load-bearing, not tidiness.** This
 * is the expensive half of a purge — a fork and checkout of the workspace
 * record per version of every document — and every one of those is a
 * synchronous WASM call. The `await`s around them look like they let the
 * daemon breathe and do not: the record is answered from the cached
 * workspace document and `versionStore.load` goes through a native binding,
 * so nothing in the chain ever reaches the timer phase, and the whole scan
 * runs as one unbroken stall.
 *
 * Measured at 5 documents x 20 versions, a fixture smaller than a real
 * workspace: 7690ms elapsed, 7670ms of it with the loop running nothing, in a
 * single 7404ms stretch. That is every request, SSE event and MCP call
 * stopped for seven seconds, and it grows with the version history. With one
 * yield per scan unit the same pass leaves the longest stall at 86ms.
 * `file-gc-loop-availability.test.ts` pins it.
 *
 * The total CPU is unchanged and is not the point: what a waiting request
 * pays is the longest CONTIGUOUS stretch, and that is what these convert from
 * "the whole pass" into "one checkout".
 *
 * Yielding while holding the workspace write barrier is safe by the same
 * argument the barrier rests on — it is an async lock, so a concurrent writer
 * in this process waits for it rather than interleaving, and the fence around
 * this call cannot be moved by the writes it excludes.
 */
async function collectReferencedFileIds(
  workspaceId: string,
  scope: StoreScope,
  versionStore: GcVersionReader,
): Promise<Set<string>> {
  const record = await openWorkspaceDocIfStored(workspaceId, scope)
  if (record === null) return new Set()
  const blobs = daemonBlobStore(scope.dataDir, scope.layout.tenantId)
  const scan = await scanFileReferences(record, {
    between: () => yieldToLoop(),
    trashBytes: async (entry) => {
      const stored = await blobs.get({ ref: entry.blob })
      if (stored === null) {
        log.warning({ workspaceId, documentId: entry.documentId }, 'trash entry has no bytes')
      }
      return stored?.bytes ?? null
    },
    versions: versionReads(workspaceId, versionStore),
  })
  if (scan.unjudged.length > 0) {
    for (const target of scan.unjudged) logUnjudged(workspaceId, target)
    throw new IncompleteFileGcScanError(workspaceId, scan.unjudged)
  }
  return scan.referenced
}

/**
 * The version store as the scan reads it. Listed by document id, not path:
 * a trashed document has no path and a shadowed one's names another
 * document, yet a restore brings either back with its versions.
 */
function versionReads(
  workspaceId: string,
  versionStore: GcVersionReader,
): NonNullable<FileReferenceReads['versions']> {
  return {
    list: (holder) => versionStore.listIdsByDocument(workspaceId, holder.documentId),
    load: (_holder, versionId) => versionStore.load(workspaceId, versionId),
  }
}

/**
 * Logged as it is reported: a scan that could not read something it must
 * judge refuses the whole purge, and the log is where an operator learns
 * which target held it back.
 */
function logUnjudged(workspaceId: string, target: UnjudgedFileHolder): void {
  switch (target.kind) {
    case 'unreadable-node':
      log.warning({ workspaceId, treeId: target.treeId }, 'unreadable workspace node')
      return
    case 'trash':
      log.warning(
        { workspaceId, documentId: target.documentId, err: target.cause },
        'skipped trash entry',
      )
      return
    case 'version': {
      const { documentId, path, versionId, cause } = target
      log.warning({ workspaceId, documentId, path, versionId, err: cause }, 'skipped version')
      return
    }
  }
}

/**
 * The two reads a scan makes of the version store. Typed as only these so a
 * caller (and a test double) supplies what the scan uses, and a new method on
 * `VersionStore` does not reach a fake that cannot know it.
 */
export type GcVersionReader = Pick<VersionStore, 'listIdsByDocument' | 'load'>

export interface PurgeFilesOptions {
  versionStore: GcVersionReader
  // Don't unlink files whose mtime is younger than this many ms. Closes
  // the upload-but-not-yet-saveDocument race: routes/files.ts writes the
  // blob first, the user (or agent) calls saveDocument later to add the
  // image element that references it. Without a grace window, GC firing
  // between those two events permanently deletes a file that was about
  // to be referenced. Default 1 hour; tests pass 0 to bypass.
  graceMs?: number
  /**
   * Which data directory's files and workspace record this pass judges.
   * Omitted, the process's — what the periodic sweeper and the route take.
   */
  scope?: StoreScope
}

/**
 * Delete the uploads nothing points at any more, and report what went.
 *
 * Two things are deliberately NOT deleted. Anything that does not look like
 * an image upload (`.tmp`, a partial write): the directory is ours, but the
 * dangling-references heuristic says nothing about those, and a future,
 * explicit cleanup is the right owner. And anything touched inside the grace
 * window: a file uploaded a moment ago is tied to no document yet, because
 * the caller is about to save the element that references it — the tombstone
 * delay is what keeps that upload -> save window from losing a legitimate
 * blob.
 *
 * A failure per file is logged and stepped over rather than raised: the file
 * may simply have vanished between the `stat` and the `unlink`, and a later
 * pass retries either way.
 */
async function unlinkDangling({
  workspaceId,
  dir,
  entries,
  referenced,
  graceMs,
}: {
  workspaceId: string
  dir: string
  entries: readonly string[]
  referenced: ReadonlySet<string>
  graceMs: number
}): Promise<{ purgedCount: number; purgedBytes: number }> {
  let purgedCount = 0
  let purgedBytes = 0
  const now = Date.now()
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase()
    if (!IMAGE_EXTS.has(ext)) continue
    if (referenced.has(basename(entry, ext))) continue
    const fullPath = join(dir, entry)
    try {
      const info = await stat(fullPath)
      if (graceMs > 0 && now - info.mtimeMs < graceMs) continue
      await unlink(fullPath)
      purgedCount += 1
      purgedBytes += info.size
    } catch (err) {
      log.warning({ workspaceId, entry, err }, 'purge skipped')
    }
  }
  return { purgedCount, purgedBytes }
}

/**
 * Parsed strictly — a bare non-negative base-10 integer — matching the
 * sibling `WHITEBOARD_FILE_GC_INTERVAL_MS`.
 *
 * `Number.parseInt` reads leading digits and discards the rest, so `1h` (the
 * most natural way to write one hour) resolved to **1 millisecond**, and
 * `30m` to 30. This window is the only thing standing between an upload that
 * has finished writing and the save that will reference it, so a value that
 * silently collapses it deletes live data — the sibling parsed strictly for
 * exactly this reason, and the two were simply written to different
 * conventions.
 *
 * One rule for the value, in storage-env.ts, and startup refuses a malformed
 * one (collectStorageEnvIssues), so a started server never reaches the
 * default below: it serves only library and test callers, for whom the
 * default is the safe direction (deleting later than asked, never sooner).
 */
function resolveGraceMs(options: PurgeFilesOptions): number {
  if (typeof options.graceMs === 'number') return Math.max(0, options.graceMs)
  const parsed = parseFileGcGraceMs(process.env)
  if (parsed.ok && parsed.value !== null) return parsed.value
  return DEFAULT_FILE_GRACE_MS
}

/**
 * The fence between the reference scan and the unlinks. Collecting forks and
 * checks out every version of every document, so it is the longest window in
 * a purge and the one another instance is most likely to write into. A record
 * that moved means the referenced set was computed against a state that no
 * longer exists, so the pass stands down rather than acting on it. Purging is
 * periodic; the next pass sees the new state and decides again.
 *
 * The containment gate is asked again here for the same reason: a files dir
 * re-pointed outside the data dir during the scan would otherwise be unlinked
 * through, and the write barrier does not stop a filesystem re-point.
 *
 * Both narrow the window to the span between this check and the unlinks
 * rather than closing it, which is what a fence over a filesystem can do —
 * the grace period covers what is left.
 */
async function fenceAfterScan(
  scope: StoreScope,
  workspaceId: string,
  before: Awaited<ReturnType<typeof catchUpWorkspaceDoc>>,
): Promise<PurgeFilesResult | null> {
  const after = await catchUpWorkspaceDoc(workspaceId, scope)
  if (after.generation !== before.generation || after.afterSeq !== before.afterSeq) {
    log.info({ workspaceId }, 'purge stood down: the workspace record moved mid-pass')
    return { purgedCount: 0, purgedBytes: 0, skippedReason: 'record-moved' as const }
  }
  await containedFilesDir(scope, workspaceId)
  return null
}

export async function purgeDanglingFiles(
  workspaceId: string,
  options: PurgeFilesOptions,
): Promise<PurgeFilesResult> {
  validateWorkspaceId(workspaceId)
  const scope = options.scope ?? globalStoreScope
  // Hold the workspace write barrier across the collect + unlink pass, so a
  // concurrent saveDocument / version-save cannot add a file reference between
  // snapshot and delete and have its file unlinked as "dangling".
  const graceMs = resolveGraceMs(options)
  return withWorkspaceWriteLock(workspaceId, async () => {
    // Asked INSIDE the barrier, not before it. Doing async work first looks
    // cheaper — there is no listing or reference collect worth starting while
    // a backup reads the tree — but it widens the gap between deciding to run
    // and holding the lock, and a concurrent route writes into that gap.
    // Measured: hoisting this above the lock let a concurrent write land a
    // half-written record between the decision and the barrier.
    //
    // A backup captures the rows as a snapshot and the uploads as a directory
    // copy, and those are two moments. Unlinking between them removes a file
    // the snapshot still references, leaving a backup that restores to a
    // document pointing at nothing — silently, since every step reported
    // success. That is ADR-0021 decision 6's far end ("retention must not
    // delete behind") in the shape this system has today.
    //
    // Standing down costs nothing: this pass is periodic (24h by default), so
    // a skipped one simply happens on the next tick.
    if (await backupIsInProgress(scope.dataDir)) {
      log.info({ workspaceId }, 'purge stood down: a backup is assembling this data directory')
      return { purgedCount: 0, purgedBytes: 0, skippedReason: 'backup-in-progress' as const }
    }

    // Judge against the RECORD, not this instance's cache. `listDocuments`
    // and `loadDocument` both read the cached workspace document, which is
    // authoritative for one daemon — every write goes through it — and is
    // simply behind for two. A pass that trusted it would not see a document
    // another instance created and would unlink its blobs as dangling. That
    // is not a narrow race: the gap is however long since this instance last
    // caught up (ADR-0020).
    //
    // Reentrant on the barrier held above: `withWorkspaceWriteLock` detects
    // an acquisition from the chain that already holds it, so this does not
    // deadlock against the lock this pass is running inside.
    const before = await catchUpWorkspaceDoc(workspaceId, scope)
    // List the candidate files BEFORE the reference scan: collecting
    // references forks + checks out every version of every document,
    // which is far too expensive to pay for a workspace that has no files
    // directory (or an empty one) — the common case for every workspace
    // the periodic sweeper visits that never had an upload.
    const dir = await containedFilesDir(scope, workspaceId)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      if (isMissingFileError(err)) return { purgedCount: 0, purgedBytes: 0 }
      throw err
    }
    if (entries.length === 0) return { purgedCount: 0, purgedBytes: 0 }

    const referenced = await collectReferencedFileIds(workspaceId, scope, options.versionStore)

    const stoodDown = await fenceAfterScan(scope, workspaceId, before)
    if (stoodDown !== null) return stoodDown

    return await unlinkDangling({ workspaceId, dir, entries, referenced, graceMs })
  })
}
