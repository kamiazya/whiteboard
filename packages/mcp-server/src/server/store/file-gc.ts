import type { LoroDoc } from 'loro-crdt'
import { readdir, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { DATA_DIR } from '../config.js'
import { getLogger } from '../log.js'
import { validateWorkspaceId } from '../validators.js'
import { listCanvases, loadCanvas } from './canvas-store.js'
import { isMissingFileError } from './corrupt-stored-data.js'
import { assertPathWithinDir } from './path-guard.js'
import type { VersionStore } from './version-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

// Garbage-collect files in <DATA_DIR>/<workspaceId>/files/ that are not
// referenced by any live canvas in the workspace — and, when a versionStore
// is supplied, by any saved past version state either.
//
// Live-only mode (no versionStore) is cheap and works well for workspaces
// that do not depend on saved-version restore for image fidelity. Pass a
// VersionStore to walk every saved version's reconstructed state too;
// that protects images that only the past states reference, at the cost
// of one Loro fork+checkout per version per canvas.

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

export interface PurgeFilesResult {
  purgedCount: number
  purgedBytes: number
}

function workspaceFilesDir(workspaceId: string): string {
  validateWorkspaceId(workspaceId)
  const dir = join(DATA_DIR, workspaceId, 'files')
  return assertPathWithinDir(dir, DATA_DIR, 'files dir')
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
    const obj = get
      ? null
      : ((el as { toJSON?: () => Record<string, unknown> }).toJSON?.() ?? null)
    const type = get ? get('type') : obj?.type
    if (type !== 'image') continue
    const isDeleted = get ? get('isDeleted') : obj?.isDeleted
    if (isDeleted === true) continue
    const fileId = get ? get('fileId') : obj?.fileId
    if (typeof fileId === 'string' && fileId.length > 0) sink.add(fileId)
  }
}

// Walk every canvas in the workspace (live state, plus past versions when
// a versionStore is supplied) and collect referenced fileIds.
export class IncompleteFileGcScanError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly skipped: ReadonlyArray<{ slug: string; versionId: string; cause: unknown }>,
  ) {
    super(
      `file-gc: refusing to purge ${workspaceId} because ${skipped.length} version(s) could not be inspected`,
    )
    this.name = 'IncompleteFileGcScanError'
  }
}

async function collectReferencedFileIds(
  workspaceId: string,
  versionStore?: VersionStore,
): Promise<Set<string>> {
  const referenced = new Set<string>()
  const skipped: Array<{ slug: string; versionId: string; cause: unknown }> = []
  const canvases = await listCanvases(workspaceId)
  for (const { slug } of canvases) {
    const live = await loadCanvas(workspaceId, slug)
    collectFromDoc(live, referenced)
    if (!versionStore) continue
    const versions = await versionStore.list(workspaceId, slug)
    for (const v of versions) {
      // load() forks the live doc internally and checks out the version's
      // frontiers. If a version cannot be inspected (missing frontier
      // rows, corrupt data) we record it as skipped — the file referenced
      // only by that version would otherwise look dangling and be deleted
      // permanently. Fail-closed at the caller below.
      try {
        const past = await versionStore.load(workspaceId, v.id, live)
        if (past) collectFromDoc(past, referenced)
      } catch (err) {
        getLogger('file-gc').warning(
          { workspaceId, slug, versionId: v.id, err },
          'skipped version',
        )
        skipped.push({ slug, versionId: v.id, cause: err })
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
        getLogger('file-gc').warning({ workspaceId, entry, err }, 'purge skipped')
      }
    }
    return { purgedCount, purgedBytes }
  })
}
