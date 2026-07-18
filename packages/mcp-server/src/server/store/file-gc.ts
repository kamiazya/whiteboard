import { readdir, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { decodeFrontiers, LoroDoc } from 'loro-crdt'
import type { z } from 'zod'
import type { purgeResultSchema } from '../../shared/api-contracts/canvas.js'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import { validateWorkspaceId } from '../validators.js'
import { loadCanvasBranches } from './branches-store.js'
import { listCanvases, loadCanvas } from './canvas-store.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'
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
// (shared/api-contracts/canvas.ts) — both routes/files.ts's response and
// this internal return type derive from it so they cannot drift apart.
export type PurgeFilesResult = z.infer<typeof purgeResultSchema>

function workspaceFilesDir(workspaceId: string): string {
  validateWorkspaceId(workspaceId)
  const dir = join(getDataDir(), workspaceId, 'files')
  return assertPathWithinDir(dir, getDataDir(), 'files dir')
}

// Walk a single doc state and collect fileIds for image elements whose
// `isDeleted` flag is falsy.
function collectFromDoc(doc: LoroDoc, sink: Set<string>): void {
  const list = doc.getMovableList('elements')
  for (let i = 0; i < list.length; i++) {
    const el = list.get(i)
    if (!el || typeof el !== 'object') continue
    const get =
      typeof (el as { get?: unknown }).get === 'function'
        ? (k: string) => (el as { get: (k: string) => unknown }).get(k)
        : null
    const obj = get ? null : ((el as { toJSON?: () => Record<string, unknown> }).toJSON?.() ?? null)
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
type SkippedScanTarget = { kind: 'version'; slug: string; versionId: string; cause: unknown }

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

export function isIncompleteFileGcScanError(error: unknown): error is IncompleteFileGcScanError {
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
  const canvases = await listCanvases(workspaceId)
  for (const { slug } of canvases) {
    const live = await loadCanvas(workspaceId, slug)
    collectFromDoc(live, referenced)

    const { branches } = await loadCanvasBranches(workspaceId, slug)
    for (const branch of branches) {
      // Every branch tip (including HEAD's, which is redundant with the
      // live scan above but harmless) is a live reference set — a file
      // is only dangling when NO branch's tip references it, not just
      // the currently checked-out one.
      try {
        const doc = checkoutFrontiersBase64(live, branch.tipFrontiers)
        if (doc) collectFromDoc(doc, referenced)
      } catch (err) {
        // Unlike a version load failure (which can stem from ambiguous
        // causes worth a retryable fail-closed refusal), a branch tip that
        // fails to decode/checkout means the persisted tipFrontiers bytes
        // themselves are malformed. No retry repairs that, so surface it
        // as corrupt_stored_data (500) instead of folding it into the
        // retryable incomplete-scan (503) path.
        log.error(
          { workspaceId, slug, branch: branch.name, err },
          'corrupt branch tipFrontiers; refusing to purge',
        )
        throw corruptStoredData(
          `${workspaceId}/${slug} branch "${branch.name}"`,
          `tipFrontiers could not be decoded or checked out (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }

    if (!versionStore) continue
    const versions = await versionStore.list(workspaceId, slug)
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
        const past = await versionStore.load(workspaceId, v.id, live)
        if (past === null) {
          throw new Error('versionStore.load returned null for a version list() just reported')
        }
        collectFromDoc(past, referenced)
      } catch (err) {
        log.warning({ workspaceId, slug, versionId: v.id, err }, 'skipped version')
        skipped.push({ kind: 'version', slug, versionId: v.id, cause: err })
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
  // the upload-but-not-yet-saveCanvas race: routes/files.ts writes the
  // blob first, the user (or agent) calls saveCanvas later to add the
  // image element that references it. Without a grace window, GC firing
  // between those two events permanently deletes a file that was about
  // to be referenced. Default 1 hour; tests pass 0 to bypass.
  graceMs?: number
}

const DEFAULT_GRACE_MS = 60 * 60 * 1000

function resolveGraceMs(options: PurgeFilesOptions): number {
  if (typeof options.graceMs === 'number') return Math.max(0, options.graceMs)
  const envRaw = process.env.WHITEBOARD_FILE_GC_GRACE_MS
  if (typeof envRaw === 'string' && envRaw.length > 0) {
    const parsed = Number.parseInt(envRaw, 10)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_GRACE_MS
}

export async function purgeDanglingFiles(
  workspaceId: string,
  options: PurgeFilesOptions = {},
): Promise<PurgeFilesResult> {
  validateWorkspaceId(workspaceId)
  // Hold the workspace write barrier across the collect + unlink pass so
  // a concurrent saveCanvas / version-save cannot insert a new file
  // reference between snapshot and delete and have its file unlinked
  // as "dangling".
  const graceMs = resolveGraceMs(options)
  return withWorkspaceWriteLock(workspaceId, async () => {
    const referenced = await collectReferencedFileIds(workspaceId, options.versionStore)

    const dir = workspaceFilesDir(workspaceId)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      if (isMissingFileError(err)) return { purgedCount: 0, purgedBytes: 0 }
      throw err
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
        // canvas yet, but the user is about to call saveCanvas with the
        // matching image element. Spare freshly-touched files so that
        // upload → saveCanvas window doesn't lose a legitimate blob.
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
