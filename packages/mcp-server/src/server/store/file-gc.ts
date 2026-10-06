import { readdir, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { purgeResultSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  type FileReferenceReads,
  scanFileReferences,
  type UnjudgedFileHolder,
} from '@kamiazya/whiteboard-loro-adapter'
import type { z } from 'zod'
import { isMissingFileError } from '../../shared/errno.js'
import { getLogger } from '../log.js'
import { blobsRoot } from '../tenant/data-layout.js'
import { validateWorkspaceId } from '../validators.js'
import { backupIsInProgress } from './backup-in-progress.js'
import { catchUpWorkspaceDoc, openWorkspaceDocIfStored } from './document-store.js'
import { FsBlobStore } from './fs/fs-blob-store.js'
import { assertPathWithinDir } from './path-guard.js'
import { parseFileGcGraceMs } from './storage-env.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import type { VersionStore } from './version-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

// Garbage-collect files in a workspace's files directory that no document
// uses. Used means referenced by a live document or a trashed one (a restore
// brings it back under the same id) and, when a versionStore is supplied, by
// any saved past version state.
//
// Live-only mode (no versionStore) is cheap and works well for workspaces
// that do not depend on saved-version restore for image fidelity. Pass a
// VersionStore to walk every saved version's reconstructed state too;
// that protects images that only the past states reference, at the cost
// of one Loro fork+checkout per version per document.
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

function workspaceFilesDir(scope: StoreScope, workspaceId: string): string {
  validateWorkspaceId(workspaceId)
  return assertPathWithinDir(
    scope.layout.workspaceFilesDir(workspaceId),
    scope.dataDir,
    'files dir',
  )
}

// Internal-only description of a document/version that GC could not safely
// inspect. Not a persisted or wire type, so no Zod schema — kept as a
// discriminated union purely to make the fail-closed reason legible in logs
// and error messages.
type SkippedScanTarget =
  | { kind: 'version'; path: string; versionId: string; cause: unknown }
  | { kind: 'unreadable-node'; treeId: string }
  | { kind: 'trash'; documentId: string; cause: unknown }

export class IncompleteFileGcScanError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly skipped: ReadonlyArray<SkippedScanTarget>,
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
  versionStore?: GcVersionReader,
): Promise<Set<string>> {
  const record = await openWorkspaceDocIfStored(workspaceId, scope)
  if (record === null) return new Set()
  const blobs = new FsBlobStore(blobsRoot(scope.dataDir, scope.layout.tenantId), scope.dataDir)
  const scan = await scanFileReferences(record, {
    between: () => yieldToLoop(),
    trashBytes: async (entry) => {
      const stored = await blobs.get({ ref: entry.blob })
      if (stored === null) {
        log.warning({ workspaceId, documentId: entry.documentId }, 'trash entry has no bytes')
      }
      return stored?.bytes ?? null
    },
    ...(versionStore === undefined ? {} : { versions: versionReads(workspaceId, versionStore) }),
  })
  const skipped = scan.unjudged.map((target) => skippedTarget(workspaceId, target))
  if (skipped.length > 0) {
    throw new IncompleteFileGcScanError(workspaceId, skipped)
  }
  return scan.referenced
}

/**
 * The version store as the scan reads it.
 *
 * ponytail: this store addresses a history by PATH, so a trashed document's
 * versions — and a shadowed one's, whose path names another document — are
 * not reached here. The browser keeper's rows are keyed by document id and do
 * reach them; listing by `documentId` is the upgrade that closes the gap.
 */
function versionReads(
  workspaceId: string,
  versionStore: GcVersionReader,
): NonNullable<FileReferenceReads['versions']> {
  return {
    list: async (holder) =>
      holder.trashed ? [] : (await versionStore.list(workspaceId, holder.path)).map((v) => v.id),
    load: (_holder, versionId) => versionStore.load(workspaceId, versionId),
  }
}

/**
 * Logged as it is reported: a scan that could not read something it must
 * judge refuses the whole purge, and the log is where an operator learns
 * which target held it back.
 */
function skippedTarget(workspaceId: string, target: UnjudgedFileHolder): SkippedScanTarget {
  switch (target.kind) {
    case 'unreadable-node':
      log.warning({ workspaceId, treeId: target.treeId }, 'unreadable workspace node')
      return target
    case 'trash':
      log.warning(
        { workspaceId, documentId: target.documentId, err: target.cause },
        'skipped trash entry',
      )
      return target
    case 'version': {
      const { path, versionId, cause } = target
      log.warning({ workspaceId, path, versionId, err: cause }, 'skipped version')
      return { kind: 'version', path, versionId, cause }
    }
  }
}

/**
 * The two reads a scan makes of the version store. Typed as only these so a
 * caller (and a test double) supplies what the scan uses, and a new method on
 * `VersionStore` does not reach a fake that cannot know it.
 */
type GcVersionReader = Pick<VersionStore, 'list' | 'load'>

export interface PurgeFilesOptions {
  versionStore?: GcVersionReader
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

const DEFAULT_GRACE_MS = 60 * 60 * 1000

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
 * A malformed value falls back to the default rather than aborting: unlike
 * `WHITEBOARD_DATABASE_URL`, a wrong value here cannot make two instances
 * disagree about what the record is, and the default is the safe direction
 * (deleting later than asked, never sooner).
 */
function resolveGraceMs(options: PurgeFilesOptions): number {
  if (typeof options.graceMs === 'number') return Math.max(0, options.graceMs)
  // One definition of the rule, in storage-env.ts, which startup also uses to
  // refuse a value it cannot understand — so a started server never reaches
  // the fallback below.
  const parsed = parseFileGcGraceMs(process.env)
  if (parsed.ok && parsed.value !== null) return parsed.value
  return DEFAULT_GRACE_MS
}

export async function purgeDanglingFiles(
  workspaceId: string,
  options: PurgeFilesOptions = {},
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
    const dir = workspaceFilesDir(scope, workspaceId)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      if (isMissingFileError(err)) return { purgedCount: 0, purgedBytes: 0 }
      throw err
    }
    if (entries.length === 0) return { purgedCount: 0, purgedBytes: 0 }

    const referenced = await collectReferencedFileIds(workspaceId, scope, options.versionStore)

    // The fence. Collecting forks and checks out every version of every
    // document, so it is the longest window in this pass and the one
    // another instance is most likely to write into. A record that moved
    // means the referenced set was computed against a state that no longer
    // exists, so this pass stands down rather than acting on it. Purging is
    // periodic; the next pass sees the new state and decides again.
    //
    // This narrows the window to the span between the check and the unlinks
    // rather than closing it, which is what a fence over a filesystem can do
    // — the grace period covers what is left.
    const after = await catchUpWorkspaceDoc(workspaceId, scope)
    if (after.generation !== before.generation || after.afterSeq !== before.afterSeq) {
      log.info({ workspaceId }, 'purge stood down: the workspace record moved mid-pass')
      return { purgedCount: 0, purgedBytes: 0, skippedReason: 'record-moved' as const }
    }

    return await unlinkDangling({ workspaceId, dir, entries, referenced, graceMs })
  })
}
