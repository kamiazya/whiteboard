import { LoroDoc, LoroMap } from 'loro-crdt'
import type { Value } from 'loro-crdt'
import { join, relative, sep } from 'node:path'
import { readFile, writeFile, readdir, stat, mkdir, access } from 'node:fs/promises'
import { DATA_DIR } from '../config.js'
import type { VersionStore } from './version-store.js'
import { loadDaemonRecord, isPidAlive } from '../../daemon/daemon-registry.js'
import { validateSessionId, validateSlug } from '../validators.js'
import {
  corruptStoredData,
  isCorruptStoredDataError,
  isMissingFileError,
} from './corrupt-stored-data.js'

// Give the error a stable name so callers, including MCP tools, can detect overwrite conflicts.
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

// ── slug validation (path separators and traversal protection) ──
// Allow hierarchical slugs made from kebab-case segments joined by `/`.
// - Each segment: one or more alphanumeric characters, hyphens allowed internally,
//   but not as the first or last character
// - `/` is allowed only as a segment separator, not at the start, end, or twice in a row
// - reject all traversal-like inputs such as `..`, `.`, and backslashes
// Example: "my-canvas" OK / "621/header" OK / "621/header-v2/layout" OK
//          "/foo" NG / "foo/" NG / "a//b" NG / "../x" NG / ".hidden" NG
//
// Error messages include both the offending segment and the concrete reason so callers
// can pinpoint what to fix.
// ── filename conversion (used only inside the store) ──
function slugToFilename(slug: string): string {
  return `${slug}.loro`
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

// Soft cap for snapshot size. Do not block saves when exceeded because preserving user
// data is more important; emit one warning per threshold breach and suggest compactCanvas().
const SNAPSHOT_WARN_BYTES = 32 * 1024 * 1024 // 32 MiB
const warnedSnapshots = new Set<string>()

// ── save LoroDoc by writing the snapshot binary ──
// Hierarchical slugs expand into subdirectories (for example "621/header" -> {sessionId}/621/header.loro).
// overwrite defaults to false so canvas_create does not destroy existing data by mistake.
// Normal incremental saves, such as WS updates and applyAndPersist, must pass overwrite: true.
export async function saveCanvas(
  sessionId: string,
  slug: string,
  doc: LoroDoc,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  validateSessionId(sessionId)
  validateSlug(slug)
  const overwrite = options.overwrite ?? false
  const path = join(DATA_DIR, sessionId, slugToFilename(slug))
  if (!overwrite) {
    const exists = await access(path).then(() => true).catch(() => false)
    if (exists) {
      throw new ConflictError(
        `Canvas "${sessionId}/${slug}" already exists. Pass { overwrite: true } to replace it.`,
      )
    }
  }
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
  const snapshot = doc.export({ mode: 'snapshot' })
  await writeFile(path, snapshot)
  // Emit a single warning when the snapshot grows past the soft cap.
  if (snapshot.byteLength > SNAPSHOT_WARN_BYTES) {
    const key = `${sessionId}/${slug}`
    if (!warnedSnapshots.has(key)) {
      warnedSnapshots.add(key)
      console.warn(
        `[canvas-store] ${key} snapshot is ${(snapshot.byteLength / 1024 / 1024).toFixed(1)} MiB ` +
          `(> ${SNAPSHOT_WARN_BYTES / 1024 / 1024} MiB). Consider compactCanvas() to GC op-log.`,
      )
    }
  }
}

// ── load LoroDoc, returning an empty document when the file is missing ──
export async function loadCanvas(sessionId: string, slug: string): Promise<LoroDoc> {
  validateSessionId(sessionId)
  validateSlug(slug)
  const path = join(DATA_DIR, sessionId, slugToFilename(slug))
  let doc: LoroDoc
  try {
    const bytes = await readFile(path)
    try {
      doc = LoroDoc.fromSnapshot(new Uint8Array(bytes))
    } catch (error) {
      throw corruptStoredData(path, `invalid canvas snapshot (${errorMessage(error)})`)
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return new LoroDoc() // Missing file -> new document.
    }
    if (isCorruptStoredDataError(error)) {
      throw error
    }
    throw corruptStoredData(path, `failed to read canvas snapshot (${errorMessage(error)})`)
  }
  // One-shot legacy container migration.
  // Older data stored "elements" in LoroList, while current code writes LoroMovableList.
  // Without this migration, old canvases can appear empty. Repair them once on load and
  // write the fixed snapshot back to disk.
  const migrated = migrateLegacyListToMovable(doc)
  if (migrated) {
    try {
      // Keep a one-time .pre-migrate-bak copy of the original file before overwriting it.
      const bakPath = `${path}.pre-migrate-bak`
      const bakExists = await access(bakPath).then(() => true).catch(() => false)
      if (!bakExists) {
        const origBytes = await readFile(path).catch(() => null)
        if (origBytes) await writeFile(bakPath, origBytes)
      }
      await saveCanvas(sessionId, slug, doc, { overwrite: true })
    } catch (err) {
      // A failed rewrite is non-fatal; the next load will retry the migration.
      console.warn(
        `[canvas-store] legacy list→movable migration persist failed for ${sessionId}/${slug}: ${errorMessage(err)}`,
      )
    }
  }
  return doc
}

// Move elements from the legacy LoroList("elements") into LoroMovableList.
// - If both containers already have elements, assume migration already happened and the
//   legacy list was left behind; do nothing to avoid duplicating data.
// - After migration, clear the legacy list to remove the dual state.
// Returns whether a real migration ran, which tells the caller whether disk rewrite is needed.
export function migrateLegacyListToMovable(doc: LoroDoc): boolean {
  const list = doc.getList('elements')
  const movable = doc.getMovableList('elements')
  if (list.length === 0) return false
  if (movable.length > 0) return false
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i)
    if (!(item instanceof LoroMap)) continue
    const json = item.toJSON() as Record<string, unknown>
    const dst = movable.insertContainer(movable.length, new LoroMap())
    for (const [k, v] of Object.entries(json)) {
      if (v !== undefined) dst.set(k, v as Value)
    }
  }
  list.delete(0, list.length)
  doc.commit()
  return true
}

export async function canvasExists(sessionId: string, slug: string): Promise<boolean> {
  validateSessionId(sessionId)
  validateSlug(slug)
  const path = join(DATA_DIR, sessionId, slugToFilename(slug))
  return access(path).then(() => true).catch(() => false)
}

// ── op-log compaction (shallow-snapshot) ──
// Long-lived canvases can accumulate a large Loro op-log. Rebuild a shallow snapshot at
// the oldest retained version frontier and GC older history.
// - If no version exists, skip compaction because there is no safe cut point.
// - History after the cut point and all version checkouts remain valid by shallow-snapshot semantics.
// Return before/after sizes so callers can log or emit metrics.
export interface CompactResult {
  compacted: boolean
  beforeBytes: number
  afterBytes: number
  reason?: 'no-versions' | 'no-file' | 'no-gain' | 'ok'
}

export async function compactCanvas(
  sessionId: string,
  slug: string,
  versionStore: VersionStore,
): Promise<CompactResult> {
  validateSessionId(sessionId)
  validateSlug(slug)
  const path = join(DATA_DIR, sessionId, slugToFilename(slug))
  let beforeBytes: number
  try {
    beforeBytes = (await stat(path)).size
  } catch (error) {
    if (isMissingFileError(error)) {
      return { compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' }
    }
    throw corruptStoredData(path, `failed to stat canvas file (${errorMessage(error)})`)
  }

  const cut = await versionStore.earliestFrontiers(sessionId, slug)
  if (!cut) {
    return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-versions' }
  }

  const doc = await loadCanvas(sessionId, slug)
  // Keep the op-log after the cut point and GC everything before it.
  const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: cut })
  if (shallow.byteLength >= beforeBytes) {
    // Skip rewriting if the document was already shallow or if the cut point gives no size benefit.
    return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-gain' }
  }
  await writeFile(path, shallow)
  return { compacted: true, beforeBytes, afterBytes: shallow.byteLength, reason: 'ok' }
}

async function readDirEntriesOrMissing(
  dir: string,
): Promise<import('node:fs').Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    throw corruptStoredData(dir, `failed to read directory (${errorMessage(error)})`)
  }
}

async function readDirEntriesStrict(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw corruptStoredData(dir, `failed to read directory (${errorMessage(error)})`)
  }
}

// ── list sessions, marking activity by daemon.json PID liveness ──
// Only directories directly under DATA_DIR are candidates.
// Skip marker files such as `.latest-session`.
export async function listSessions(): Promise<
  { sessionId: string; daemonAlive: boolean }[]
> {
  const entries = await readDirEntriesOrMissing(DATA_DIR)
  if (!entries) {
    return []
  }
  const daemon = await loadDaemonRecord(DATA_DIR)
  const daemonAlive = daemon ? isPidAlive(daemon.pid) : false
  // Exclude dot-prefixed directories such as `.checkpoints` because they hold metadata.
  // Session ids come from nanoid, so they never begin with a dot.
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  return dirs.map(({ name: sessionId }) => ({
    sessionId,
    daemonAlive,
  }))
}

// ── list canvases by recursively finding .loro files and returning session-relative slugs ──
// Example: {sessionId}/621/header.loro -> slug="621/header", {sessionId}/solo.loro -> slug="solo"
// Exclude known non-canvas directories such as `files/`, `exports/`, and `versions/`.
export async function listCanvases(
  sessionId: string,
): Promise<{ slug: string; updatedAt: string }[]> {
  validateSessionId(sessionId)
  const sessionDir = join(DATA_DIR, sessionId)
  const rootEntries = await readDirEntriesOrMissing(sessionDir)
  if (!rootEntries) {
    return []
  }
  const results: { slug: string; updatedAt: string }[] = []

  async function walk(dir: string, entries?: import('node:fs').Dirent[]): Promise<void> {
    const currentEntries = entries ?? (await readDirEntriesStrict(dir))
    for (const entry of currentEntries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Skip known non-canvas directories.
        // versions/ must be excluded because version-store may contain .loro files inside it.
        if (
          entry.name === 'exports' ||
          entry.name === 'files' ||
          entry.name === 'versions'
        )
          continue
        await walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.loro')) {
        let s
        try {
          s = await stat(full)
        } catch (error) {
          throw corruptStoredData(full, `failed to stat canvas file (${errorMessage(error)})`)
        }
        // Rebuild the slug from the session-relative path, normalizing path separators to "/".
        const rel = relative(sessionDir, full).replace(new RegExp(`\\${sep}`, 'g'), '/')
        const slug = rel.replace(/\.loro$/, '')
        results.push({ slug, updatedAt: s.mtime.toISOString() })
      }
    }
  }

  await walk(sessionDir, rootEntries)
  return results
}
