import { LoroDoc, LoroMap } from 'loro-crdt'
import type { Value } from 'loro-crdt'
import { dirname, join } from 'node:path'
import { readFile, writeFile, stat, mkdir, access } from 'node:fs/promises'
import { DATA_DIR } from '../config.js'
import type { VersionStore } from './version-store.js'
import { loadDaemonRecord, isPidAlive } from '../../daemon/daemon-registry.js'
import { validateWorkspaceId, validateSlug } from '../validators.js'
import {
  corruptStoredData,
  isCorruptStoredDataError,
  isMissingFileError,
} from './corrupt-stored-data.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { upsertCanvasRow, upsertWorkspaceRow } from './db/upsert-workspace.js'

// Give the error a stable name so callers, including MCP tools, can detect overwrite conflicts.
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

// ── canvas blob path helpers ──
// Snapshots live under {dataDir}/blobs/{workspaceId}/canvas/{slug}.loro.
// Hierarchical slugs (e.g. "621/header") expand into nested directories
// inside the canvas/ root, matching the legacy layout one level deeper so
// the blob root stays clean.
function blobsRoot(): string {
  return join(DATA_DIR, 'blobs')
}

function canvasBlobPath(workspaceId: string, slug: string): string {
  return join(blobsRoot(), workspaceId, 'canvas', `${slug}.loro`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

// Soft cap for snapshot size. Do not block saves when exceeded because preserving user
// data is more important; emit one warning per threshold breach and suggest compactCanvas().
const SNAPSHOT_WARN_BYTES = 32 * 1024 * 1024 // 32 MiB
const warnedSnapshots = new Set<string>()

async function dbReady() {
  await prepareDataDir(DATA_DIR)
  return getDb(DATA_DIR)
}

// ── save LoroDoc by writing the snapshot binary to the blobs/ tree and
//    upserting the matching DB rows. ──
// overwrite defaults to false so canvas_create does not destroy existing
// data by mistake. Normal incremental saves (WS updates, applyAndPersist,
// compactCanvas) must pass overwrite: true.
export async function saveCanvas(
  workspaceId: string,
  slug: string,
  doc: LoroDoc,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const overwrite = options.overwrite ?? false
  const path = canvasBlobPath(workspaceId, slug)
  const db = await dbReady()
  if (!overwrite) {
    const existing = await db
      .selectFrom('canvases')
      .select(['slug'])
      .where('workspaceId', '=', workspaceId)
      .where('slug', '=', slug)
      .executeTakeFirst()
    if (existing) {
      throw new ConflictError(
        `Canvas "${workspaceId}/${slug}" already exists. Pass { overwrite: true } to replace it.`,
      )
    }
  }
  await mkdir(dirname(path), { recursive: true })
  const snapshot = doc.export({ mode: 'snapshot' })
  await writeFile(path, snapshot)
  await upsertWorkspaceRow(db, workspaceId)
  await upsertCanvasRow(db, workspaceId, slug)
  await db
    .updateTable('canvases')
    .set({ updatedAt: Date.now() })
    .where('workspaceId', '=', workspaceId)
    .where('slug', '=', slug)
    .execute()
  if (snapshot.byteLength > SNAPSHOT_WARN_BYTES) {
    const key = `${workspaceId}/${slug}`
    if (!warnedSnapshots.has(key)) {
      warnedSnapshots.add(key)
      console.warn(
        `[canvas-store] ${key} snapshot is ${(snapshot.byteLength / 1024 / 1024).toFixed(1)} MiB ` +
          `(> ${SNAPSHOT_WARN_BYTES / 1024 / 1024} MiB). Consider compactCanvas() to GC op-log.`,
      )
    }
  }
}

// ── load LoroDoc, returning an empty document when the blob is missing ──
export async function loadCanvas(workspaceId: string, slug: string): Promise<LoroDoc> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const path = canvasBlobPath(workspaceId, slug)
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
      return new LoroDoc()
    }
    if (isCorruptStoredDataError(error)) {
      throw error
    }
    throw corruptStoredData(path, `failed to read canvas snapshot (${errorMessage(error)})`)
  }
  // One-shot legacy container migration. Older data stored "elements" in
  // LoroList; current code uses LoroMovableList. Repair on load and rewrite.
  const migrated = migrateLegacyListToMovable(doc)
  if (migrated) {
    try {
      const bakPath = `${path}.pre-migrate-bak`
      const bakExists = await access(bakPath).then(() => true).catch(() => false)
      if (!bakExists) {
        const origBytes = await readFile(path).catch(() => null)
        if (origBytes) await writeFile(bakPath, origBytes)
      }
      await saveCanvas(workspaceId, slug, doc, { overwrite: true })
    } catch (err) {
      console.warn(
        `[canvas-store] legacy list→movable migration persist failed for ${workspaceId}/${slug}: ${errorMessage(err)}`,
      )
    }
  }
  return doc
}

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

export async function canvasExists(workspaceId: string, slug: string): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const db = await dbReady()
  const row = await db
    .selectFrom('canvases')
    .select(['slug'])
    .where('workspaceId', '=', workspaceId)
    .where('slug', '=', slug)
    .executeTakeFirst()
  return !!row
}

export interface CompactResult {
  compacted: boolean
  beforeBytes: number
  afterBytes: number
  reason?: 'no-versions' | 'no-file' | 'no-gain' | 'ok'
}

export async function compactCanvas(
  workspaceId: string,
  slug: string,
  versionStore: VersionStore,
): Promise<CompactResult> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const path = canvasBlobPath(workspaceId, slug)
  let beforeBytes: number
  try {
    beforeBytes = (await stat(path)).size
  } catch (error) {
    if (isMissingFileError(error)) {
      return { compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' }
    }
    throw corruptStoredData(path, `failed to stat canvas file (${errorMessage(error)})`)
  }

  const cut = await versionStore.earliestFrontiers(workspaceId, slug)
  if (!cut) {
    return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-versions' }
  }

  const doc = await loadCanvas(workspaceId, slug)
  const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: cut })
  if (shallow.byteLength >= beforeBytes) {
    return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-gain' }
  }
  await writeFile(path, shallow)
  return { compacted: true, beforeBytes, afterBytes: shallow.byteLength, reason: 'ok' }
}

// ── list workspaces from the workspaces table ──
// daemonAlive still reflects the daemon record on disk; that is a runtime
// signal, not workspace metadata, so it stays a separate fast probe.
export async function listWorkspaces(): Promise<
  { workspaceId: string; daemonAlive: boolean }[]
> {
  const db = await dbReady()
  const daemon = await loadDaemonRecord(DATA_DIR)
  const daemonAlive = daemon ? isPidAlive(daemon.pid) : false
  const rows = await db.selectFrom('workspaces').select(['id', 'updatedAt']).execute()
  return rows.map((r) => ({ workspaceId: r.id, daemonAlive }))
}

// ── list canvases from the canvases table ──
export async function listCanvases(
  workspaceId: string,
): Promise<{ slug: string; updatedAt: string }[]> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  const rows = await db
    .selectFrom('canvases')
    .select(['slug', 'updatedAt'])
    .where('workspaceId', '=', workspaceId)
    .execute()
  return rows.map((r) => ({
    slug: r.slug,
    updatedAt: new Date(r.updatedAt).toISOString(),
  }))
}
