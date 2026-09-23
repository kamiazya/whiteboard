import { readdir, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { purgeResultSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { collectImageRefIds } from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'
import type { z } from 'zod'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import { workspaceFilesDir as tenantFilesDir } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { validateWorkspaceId } from '../validators.js'
import { backupIsInProgress } from './backup-in-progress.js'
import { isMissingFileError } from './corrupt-stored-data.js'
import { catchUpWorkspaceDoc, listDocuments, loadDocument } from './document-store.js'
import { assertPathWithinDir } from './path-guard.js'
import { parseFileGcGraceMs } from './storage-env.js'
import type { VersionStore } from './version-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

// Garbage-collect files in <getDataDir()>/<workspaceId>/files/ that are not
// referenced by any live canvas in the workspace — and, when a versionStore
// is supplied, by any saved past version state either.
//
// Live-only mode (no versionStore) is cheap and works well for workspaces
// that do not depend on saved-version restore for image fidelity. Pass a
// VersionStore to walk every saved version's reconstructed state too;
// that protects images that only the past states reference, at the cost
// of one Loro fork+checkout per version per canvas.

const log = getLogger('file-gc')

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

// Single source of truth for the wire shape is purgeResultSchema
// (daemon-client's api-contracts/document.ts) — both routes/files.ts's response and
// this internal return type derive from it so they cannot drift apart.
export type PurgeFilesResult = z.infer<typeof purgeResultSchema>

function workspaceFilesDir(workspaceId: string): string {
  validateWorkspaceId(workspaceId)
  const dir = tenantFilesDir(getDataDir(), SELF_HOST_TENANT_ID, workspaceId)
  return assertPathWithinDir(dir, getDataDir(), 'files dir')
}

/**
 * One entry of the legacy `elements` list, as three plain reads.
 *
 * A CONTAINER entry answers through `.get`; a plain-VALUE entry — the shape a
 * workspace-tree projection carries a legacy list in — is its own record and
 * answers through `toJSON()` or directly. Asking that question once here is
 * what lets the caller read the three fields without repeating it per field.
 */
function legacyElementFields(el: unknown): {
  type: unknown
  isDeleted: unknown
  fileId: unknown
} | null {
  if (!el || typeof el !== 'object') return null
  if (typeof (el as { get?: unknown }).get === 'function') {
    const get = (el as { get: (k: string) => unknown }).get.bind(el)
    return { type: get('type'), isDeleted: get('isDeleted'), fileId: get('fileId') }
  }
  const obj =
    (el as { toJSON?: () => Record<string, unknown> }).toJSON?.() ?? (el as Record<string, unknown>)
  return { type: obj.type, isDeleted: obj.isDeleted, fileId: obj.fileId }
}

// Walk a single doc state and collect fileIds referenced by it. Two passes,
// both additive into the same sink:
//
// 1. The CURRENT model — collectImageRefIds, the walk shared with the
//    browser's promote transfer so the two sides cannot drift on what
//    counts as a live reference.
// 2. The legacy 'elements' movable list — retired, but a pre-migration doc
//    that was never resaved through the current model still stores its
//    images there, so this pass stays as a fallback rather than a rewrite.
function collectFromDoc(doc: LoroDoc, sink: Set<string>): void {
  for (const id of collectImageRefIds(doc)) sink.add(id)

  const list = doc.getMovableList('elements')
  for (let i = 0; i < list.length; i++) {
    const fields = legacyElementFields(list.get(i))
    if (fields === null || fields.type !== 'image' || fields.isDeleted === true) continue
    if (typeof fields.fileId === 'string' && fields.fileId.length > 0) sink.add(fields.fileId)
  }
}

// Internal-only description of a canvas/version that GC could not safely
// inspect. Not a persisted or wire type, so no Zod schema — kept as a
// discriminated union purely to make the fail-closed reason legible in logs
// and error messages.
type SkippedScanTarget = { kind: 'version'; path: string; versionId: string; cause: unknown }

// Walk every canvas in the workspace (live state plus past versions) and
// collect referenced fileIds.
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
 * Every fileId any state of this workspace still points at.
 *
 * **The `yieldToLoop()` calls are load-bearing, not tidiness.** This is the
 * expensive half of a purge — a fork and checkout of the workspace record per
 * version of every document — and every one of those is a
 * synchronous WASM call. The `await`s around them look like they let the
 * daemon breathe and do not: `loadDocument` answers from the cached workspace
 * document and `versionStore.load` goes through a native binding, so nothing
 * in the chain ever reaches the timer phase, and the whole scan runs as one
 * unbroken stall.
 *
 * Measured at 5 documents x 20 versions, a fixture smaller than a real
 * workspace: 7690ms elapsed, 7670ms of it with the loop running nothing, in a
 * single 7404ms stretch. That is every request, WebSocket frame and MCP call
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
  versionStore?: VersionStore,
): Promise<Set<string>> {
  const referenced = new Set<string>()
  const skipped: SkippedScanTarget[] = []
  const documents = await listDocuments(workspaceId)
  for (const { path } of documents) {
    // One per scan unit: document, version. See above.
    await yieldToLoop()
    const live = await loadDocument(workspaceId, path)
    collectFromDoc(live, referenced)

    if (!versionStore) continue
    const versions = await versionStore.list(workspaceId, path)
    for (const v of versions) {
      await yieldToLoop()
      // load() forks the live doc internally and checks out the version's
      // frontiers. If a version cannot be inspected (missing frontier
      // rows, corrupt data, or load() itself reporting the version does
      // not exist even though list() just returned it) we record it as
      // skipped — the file referenced only by that version would
      // otherwise look dangling and be deleted permanently. Fail-closed
      // at the caller below; a silent skip here is equivalent to
      // "treat it as referencing nothing", which is the exact bug this
      // guards against.
      try {
        const past = await versionStore.load(workspaceId, v.id)
        if (past === null) {
          throw new Error('versionStore.load returned null for a version list() just reported')
        }
        collectFromDoc(past, referenced)
      } catch (err) {
        log.warning({ workspaceId, path, versionId: v.id, err }, 'skipped version')
        skipped.push({ kind: 'version', path, versionId: v.id, cause: err })
      }
    }
  }
  if (skipped.length > 0) {
    throw new IncompleteFileGcScanError(workspaceId, skipped)
  }
  return referenced
}

export interface PurgeFilesOptions {
  versionStore?: VersionStore
  // Don't unlink files whose mtime is younger than this many ms. Closes
  // the upload-but-not-yet-saveDocument race: routes/files.ts writes the
  // blob first, the user (or agent) calls saveDocument later to add the
  // image element that references it. Without a grace window, GC firing
  // between those two events permanently deletes a file that was about
  // to be referenced. Default 1 hour; tests pass 0 to bypass.
  graceMs?: number
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
  // Hold the workspace write barrier across the collect + unlink pass so
  // a concurrent saveDocument / version-save cannot insert a new file
  // reference between snapshot and delete and have its file unlinked
  // as "dangling".
  const graceMs = resolveGraceMs(options)
  return withWorkspaceWriteLock(workspaceId, async () => {
    // Asked INSIDE the barrier, not before it. Doing async work first looks
    // cheaper — there is no listing or reference collect worth starting while
    // a backup reads the tree — but it widens the gap between deciding to run
    // and holding the lock, and a concurrent route writes into that gap.
    // Measured: hoisting this above the lock broke the PUT /head
    // serialisation case with a half-written tipFrontiers.
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
    if (await backupIsInProgress(getDataDir())) {
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
    const before = await catchUpWorkspaceDoc(workspaceId)
    // List the candidate files BEFORE the reference scan: collecting
    // references forks + checks out every version of every canvas,
    // which is far too expensive to pay for a workspace that has no files
    // directory (or an empty one) — the common case for every workspace
    // the periodic sweeper visits that never had an upload.
    const dir = workspaceFilesDir(workspaceId)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      if (isMissingFileError(err)) return { purgedCount: 0, purgedBytes: 0 }
      throw err
    }
    if (entries.length === 0) return { purgedCount: 0, purgedBytes: 0 }

    const referenced = await collectReferencedFileIds(workspaceId, options.versionStore)

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
    const after = await catchUpWorkspaceDoc(workspaceId)
    if (after.generation !== before.generation || after.afterSeq !== before.afterSeq) {
      log.info({ workspaceId }, 'purge stood down: the workspace record moved mid-pass')
      return { purgedCount: 0, purgedBytes: 0, skippedReason: 'record-moved' as const }
    }

    return await unlinkDangling({ workspaceId, dir, entries, referenced, graceMs })
  })
}
