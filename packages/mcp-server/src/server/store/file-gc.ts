import { readdir, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  projectWorkspaceDocument,
  readSpatialCanvas,
  resolveWorkspaceDocument,
} from '@kamiazya/whiteboard-loro-adapter'
import { imageRefId, isImageRef } from '@kamiazya/whiteboard-model'
import { decodeFrontiers, LoroDoc } from 'loro-crdt'
import type { z } from 'zod'
import type { purgeResultSchema } from '../../shared/api-contracts/document.js'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import { validateWorkspaceId } from '../validators.js'
import { loadDocumentBranches } from './branches-store.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'
import {
  catchUpWorkspaceDoc,
  cloneStoredWorkspaceDoc,
  listDocuments,
  loadDocument,
} from './document-store.js'
import { assertPathWithinDir } from './path-guard.js'
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
// (shared/api-contracts/document.ts) — both routes/files.ts's response and
// this internal return type derive from it so they cannot drift apart.
export type PurgeFilesResult = z.infer<typeof purgeResultSchema>

function workspaceFilesDir(workspaceId: string): string {
  validateWorkspaceId(workspaceId)
  const dir = join(getDataDir(), workspaceId, 'files')
  return assertPathWithinDir(dir, getDataDir(), 'files dir')
}

// Walk a single doc state and collect fileIds referenced by it. Two passes,
// both additive into the same sink:
//
// 1. The CURRENT model — every production doc stores spatial content in the
//    nodes/edges maps (see readSpatialCanvas), so a 'file' node whose `file`
//    value carries the 'asset:' upload-reference prefix is a live reference.
// 2. The legacy 'elements' movable list — retired, but a pre-migration doc
//    that was never resaved through the current model still stores its
//    images there, so this pass stays as a fallback rather than a rewrite.
function collectFromDoc(doc: LoroDoc, sink: Set<string>): void {
  const { nodes } = readSpatialCanvas(doc)
  for (const node of nodes) {
    if (node.type !== 'file') continue
    if (isImageRef(node.file)) sink.add(imageRefId(node.file))
  }

  const list = doc.getMovableList('elements')
  for (let i = 0; i < list.length; i++) {
    const el = list.get(i)
    if (!el || typeof el !== 'object') continue
    const get =
      typeof (el as { get?: unknown }).get === 'function'
        ? (k: string) => (el as { get: (k: string) => unknown }).get(k)
        : null
    // Container entries answer via .get/.toJSON; a plain-VALUE entry — the
    // shape a workspace-tree projection carries a legacy list in — is its
    // own record.
    const obj = get
      ? null
      : ((el as { toJSON?: () => Record<string, unknown> }).toJSON?.() ??
        (el as Record<string, unknown>))
    const type = get ? get('type') : obj?.type
    if (type !== 'image') continue
    const isDeleted = get ? get('isDeleted') : obj?.isDeleted
    if (isDeleted === true) continue
    const fileId = get ? get('fileId') : obj?.fileId
    if (typeof fileId === 'string' && fileId.length > 0) sink.add(fileId)
  }
}

// Internal-only description of a canvas/version that GC could not safely
// inspect. Not a persisted or wire type, so no Zod schema — kept as a
// discriminated union purely to make the fail-closed reason legible in logs
// and error messages. A branch tip that fails to decode/checkout is NOT
// represented here: that failure means the persisted tipFrontiers bytes are
// corrupt (no retry repairs it), so it throws corruptStoredData directly
// instead of being collected as a skipped, retryable target.
type SkippedScanTarget = { kind: 'version'; path: string; versionId: string; cause: unknown }

// Walk every canvas in the workspace (live state, plus past versions and
// every branch tip) and collect referenced fileIds.
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

// Fork the live doc through a snapshot and checkout the given base64
// frontiers, mirroring version-store.ts's load(). Returns null for an
// empty/unset tip (fresh branch off nothing — no history to check out,
// equivalent to the live doc referencing nothing extra).
function checkoutFrontiersBase64(live: LoroDoc, frontiersBase64: string): LoroDoc | null {
  if (frontiersBase64.length === 0) return null
  const clone = LoroDoc.fromSnapshot(live.export({ mode: 'snapshot' }))
  const frontiers = decodeFrontiers(new Uint8Array(Buffer.from(frontiersBase64, 'base64')))
  clone.checkout(frontiers)
  return clone
}

async function collectReferencedFileIds(
  workspaceId: string,
  versionStore?: VersionStore,
): Promise<Set<string>> {
  const referenced = new Set<string>()
  const skipped: SkippedScanTarget[] = []
  const documents = await listDocuments(workspaceId)
  // A tree-served document's branch tips are recorded against the WORKSPACE
  // record's oplog (app.ts getCurrentFrontiers), so they check out on a
  // clone of that record and the document is projected at that point; the
  // per-document fallback survives only for the damaged-content remnant the
  // fold could not move.
  const wsClone = await cloneStoredWorkspaceDoc(workspaceId)
  for (const { path } of documents) {
    const live = await loadDocument(workspaceId, path)
    collectFromDoc(live, referenced)

    const wsEntry = wsClone === null ? null : resolveWorkspaceDocument(wsClone, path)
    const checkoutTip = (frontiersBase64: string): LoroDoc | null => {
      if (frontiersBase64.length === 0) return null
      if (wsClone !== null && wsEntry !== null) {
        const at = LoroDoc.fromSnapshot(wsClone.export({ mode: 'snapshot' }))
        at.checkout(decodeFrontiers(new Uint8Array(Buffer.from(frontiersBase64, 'base64'))))
        return projectWorkspaceDocument(at, wsEntry.documentId)
      }
      return checkoutFrontiersBase64(live, frontiersBase64)
    }

    const { branches } = await loadDocumentBranches(workspaceId, path)
    for (const branch of branches) {
      // Every branch tip (including HEAD's, which is redundant with the
      // live scan above but harmless) is a live reference set — a file
      // is only dangling when NO branch's tip references it, not just
      // the currently checked-out one.
      try {
        const doc = checkoutTip(branch.tipFrontiers)
        if (doc) collectFromDoc(doc, referenced)
      } catch (err) {
        // Unlike a version load failure (which can stem from ambiguous
        // causes worth a retryable fail-closed refusal), a branch tip that
        // fails to decode/checkout means the persisted tipFrontiers bytes
        // themselves are malformed. No retry repairs that, so surface it
        // as corrupt_stored_data (500) instead of folding it into the
        // retryable incomplete-scan (503) path.
        log.error(
          { workspaceId, path, branch: branch.name, err },
          'corrupt branch tipFrontiers; refusing to purge',
        )
        throw corruptStoredData(
          `${workspaceId}/${path} branch "${branch.name}"`,
          `tipFrontiers could not be decoded or checked out (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }

    if (!versionStore) continue
    const versions = await versionStore.list(workspaceId, path)
    for (const v of versions) {
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
  const envRaw = process.env.WHITEBOARD_FILE_GC_GRACE_MS
  if (typeof envRaw === 'string' && /^\d+$/.test(envRaw)) {
    const parsed = Number(envRaw)
    if (Number.isSafeInteger(parsed)) return parsed
  }
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
    // references forks + checks out every branch/version of every canvas,
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

    // The fence. Collecting forks and checks out every branch and version of
    // every document, so it is the longest window in this pass and the one
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

    let purgedCount = 0
    let purgedBytes = 0
    const now = Date.now()
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase()
      // Skip anything that does not look like an image upload — the dir
      // is ours, but stray files (.tmp, partial uploads) should not be
      // deleted by the dangling-references heuristic; leave them for a
      // future, more explicit cleanup.
      if (!IMAGE_EXTS.has(ext)) continue
      const fileId = basename(entry, ext)
      if (referenced.has(fileId)) continue
      const fullPath = join(dir, entry)
      try {
        const info = await stat(fullPath)
        // Tombstone delay: a file uploaded just now isn't tied to any
        // canvas yet, but the user is about to call saveDocument with the
        // matching image element. Spare freshly-touched files so that
        // upload → saveDocument window doesn't lose a legitimate blob.
        if (graceMs > 0 && now - info.mtimeMs < graceMs) continue
        await unlink(fullPath)
        purgedCount += 1
        purgedBytes += info.size
      } catch (err) {
        // Race: file vanished between stat and unlink, or unlink failed
        // for another reason — log and move on. Subsequent runs will
        // retry.
        log.warning({ workspaceId, entry, err }, 'purge skipped')
      }
    }
    return { purgedCount, purgedBytes }
  })
}
