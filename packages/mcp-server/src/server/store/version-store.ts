import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Frontiers } from 'loro-crdt'
import { decodeFrontiers, encodeFrontiers, LoroDoc } from 'loro-crdt'
import { nanoid } from 'nanoid'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import {
  validateBranchName,
  validateSlug,
  validateVersionId,
  validateWorkspaceId,
} from '../validators.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'
import { countAliveNodes } from './count-alive-nodes.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { getCanvasIdBySlug, upsertCanvasRow } from './db/upsert-workspace.js'
import { assertPathWithinDir } from './path-guard.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

// Loro-native versioning, backed by the sqlite metadata DB.
//
// Storage:
//   versions table        -> per-version metadata + base64 frontiers
//   blobs/{ws}/versions/{id}.png  -> optional thumbnail blob
//
// load() forks the live doc from a snapshot, checks out the saved frontiers,
// and returns an independent past-state doc without touching the live cache
// entry. CRDT history cannot be forgotten, so route-level restore writes
// reverse ops on top of the live doc rather than overwriting it.

const MAX_AUTO_PER_CANVAS = 50
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

export interface OperatorInfo {
  kind: 'ai' | 'human' | 'system'
  peerId: string
  displayName?: string
  agentId?: string
  workspaceId?: string
}

export interface VersionEntry {
  id: string
  slug: string
  createdAt: string
  elementCount: number
  label?: string
  auto: boolean
  operator?: OperatorInfo
  hasThumbnail: boolean
  branchName: string
}

export interface VersionStore {
  save(
    workspaceId: string,
    slug: string,
    doc: LoroDoc,
    opts: { auto: boolean; label?: string; branchName?: string; operator?: OperatorInfo },
  ): Promise<VersionEntry>
  // liveDoc is passed in so checkout can happen on a clone without affecting
  // the live document. Returns an independent past-state doc.
  load(workspaceId: string, id: string, liveDoc: LoroDoc): Promise<LoroDoc | null>
  list(workspaceId: string, slug: string): Promise<VersionEntry[]>
  saveThumbnail(workspaceId: string, id: string, bytes: Uint8Array): Promise<void>
  loadThumbnail(workspaceId: string, id: string): Promise<Uint8Array | null>
  // Frontiers referenced by the oldest retained version for this slug. Returns
  // null when none exist, because compaction would otherwise risk losing all
  // history.
  earliestFrontiers(workspaceId: string, slug: string): Promise<Frontiers | null>
  // Public API used when creating branches from a version id.
  // Returns null only when the version is missing.
  getFrontiersBase64(workspaceId: string, id: string): Promise<string | null>
  // Rewrite branchName from oldName to newName for all versions of the given
  // slug. Returns the number of rewritten rows.
  renameBranchInVersions(
    workspaceId: string,
    slug: string,
    oldName: string,
    newName: string,
  ): Promise<number>
  // Drop auto-saved versions strictly between two manual versions, per
  // branch. Manual versions are explicit user save-points so sandwiched
  // autos add no rollback value beyond what the bracketing manuals
  // already give. Autos before the first manual or after the last manual
  // stay (they are the only rollback target outside the bracketed range).
  pruneSandwichedAutoVersions(
    workspaceId: string,
    slug: string,
  ): Promise<{ deletedCount: number; deletedIds: string[] }>
}

function blobsRoot(): string {
  return join(getDataDir(), 'blobs')
}

function versionsBlobDir(workspaceId: string): string {
  validateWorkspaceId(workspaceId)
  const dir = join(blobsRoot(), workspaceId, 'versions')
  return assertPathWithinDir(dir, blobsRoot(), 'version path')
}

// Exported so canvas-store's deleteCanvas can unlink a canvas's version
// thumbnails without duplicating this path join.
export function thumbnailPath(workspaceId: string, id: string): string {
  validateVersionId(id)
  const dir = versionsBlobDir(workspaceId)
  return assertPathWithinDir(join(dir, `${id}.png`), dir, 'version path')
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

async function dbReady() {
  await prepareDataDir(getDataDir())
  return getDb(getDataDir())
}

interface VersionRow {
  id: string
  canvasId: string
  branchName: string
  auto: number
  label: string | null
  operatorKind: 'ai' | 'human' | 'system'
  operatorPeerId: string
  operatorDisplayName: string | null
  operatorAgentId: string | null
  operatorWorkspaceId: string | null
  elementCount: number
  frontiers: string
  hasThumbnail: number
  createdAt: number
  // The store hydrates this from the canvases row at list time so callers
  // still see a slug field on each entry.
  slug: string
}

function rowToEntry(row: VersionRow): VersionEntry {
  const operator: OperatorInfo | undefined =
    row.operatorPeerId.length > 0
      ? {
          kind: row.operatorKind,
          peerId: row.operatorPeerId,
          ...(row.operatorDisplayName !== null ? { displayName: row.operatorDisplayName } : {}),
          ...(row.operatorAgentId !== null ? { agentId: row.operatorAgentId } : {}),
          ...(row.operatorWorkspaceId !== null ? { workspaceId: row.operatorWorkspaceId } : {}),
        }
      : undefined
  return {
    id: row.id,
    slug: row.slug,
    createdAt: new Date(row.createdAt).toISOString(),
    elementCount: row.elementCount,
    auto: row.auto === 1,
    branchName: row.branchName,
    hasThumbnail: row.hasThumbnail === 1,
    ...(row.label !== null ? { label: row.label } : {}),
    ...(operator !== undefined ? { operator } : {}),
  }
}

export class FileVersionStore implements VersionStore {
  async save(
    workspaceId: string,
    slug: string,
    doc: LoroDoc,
    opts: { auto: boolean; label?: string; branchName?: string; operator?: OperatorInfo },
  ): Promise<VersionEntry> {
    validateWorkspaceId(workspaceId)
    validateSlug(slug)
    // Hold the per-workspace write barrier so a concurrent
    // purgeDanglingFiles cannot interleave with the version row being
    // created. The references this save records are a subset of what
    // GC already inspected, but pairing both writers behind the same
    // queue keeps the lock contract uniform — all "things that might
    // change what GC considers referenced" run serially.
    return withWorkspaceWriteLock(workspaceId, async () => {
      const branchName = opts.branchName ?? 'main'
      validateBranchName(branchName)
      const id = nanoid(12)
      validateVersionId(id)

      // Fail-soft: a doc whose spatial read throws still saves, with an
      // advisory 0 rather than blocking the save entirely.
      const elementCount = (() => {
        try {
          return countAliveNodes(doc)
        } catch {
          return 0
        }
      })()

      const frontiers = bytesToBase64(encodeFrontiers(doc.frontiers()))
      const createdAt = Date.now()
      const operator = opts.operator

      const db = await dbReady()
      const canvasId = await upsertCanvasRow(db, workspaceId, slug)
      await db
        .insertInto('versions')
        .values({
          id,
          canvasId,
          branchName,
          auto: opts.auto ? 1 : 0,
          label: opts.label ?? null,
          operatorKind: operator?.kind ?? 'system',
          operatorPeerId: operator?.peerId ?? '',
          operatorDisplayName: operator?.displayName ?? null,
          operatorAgentId: operator?.agentId ?? null,
          operatorWorkspaceId: operator?.workspaceId ?? null,
          elementCount,
          frontiers,
          hasThumbnail: 0,
          createdAt,
        })
        .execute()

      await this.prune(workspaceId, canvasId)

      return {
        id,
        slug,
        createdAt: new Date(createdAt).toISOString(),
        elementCount,
        auto: opts.auto,
        branchName,
        hasThumbnail: false,
        ...(opts.label !== undefined ? { label: opts.label } : {}),
        ...(operator !== undefined ? { operator } : {}),
      }
    })
  }

  async load(workspaceId: string, id: string, liveDoc: LoroDoc): Promise<LoroDoc | null> {
    validateWorkspaceId(workspaceId)
    validateVersionId(id)
    const db = await dbReady()
    const row = await db
      .selectFrom('versions')
      .innerJoin('canvases', 'canvases.id', 'versions.canvasId')
      .select(['versions.frontiers'])
      .where('canvases.workspaceId', '=', workspaceId)
      .where('versions.id', '=', id)
      .executeTakeFirst()
    if (!row) return null
    // Fork the live doc through a snapshot so checkout does not affect the
    // live attached document. The clone stays in detached mode after checkout;
    // toJSON reflects the past state but commit/insert are blocked, which is
    // sufficient because callers only need to read past elements.
    const clone = LoroDoc.fromSnapshot(liveDoc.export({ mode: 'snapshot' }))
    try {
      const frontiers = decodeFrontiers(base64ToBytes(row.frontiers))
      clone.checkout(frontiers)
    } catch (error) {
      throw corruptStoredData(
        `versions/${id}`,
        `frontiers could not be checked out against the live document (${errorMessage(error)})`,
      )
    }
    return clone
  }

  async list(workspaceId: string, slug: string): Promise<VersionEntry[]> {
    validateWorkspaceId(workspaceId)
    validateSlug(slug)
    const db = await dbReady()
    const canvasId = await getCanvasIdBySlug(db, workspaceId, slug)
    if (!canvasId) return []
    const rows = await db
      .selectFrom('versions')
      .selectAll()
      .where('canvasId', '=', canvasId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute()
    return rows.map((r) => rowToEntry({ ...r, slug } as VersionRow))
  }

  async saveThumbnail(workspaceId: string, id: string, bytes: Uint8Array): Promise<void> {
    validateVersionId(id)
    if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
      throw new Error(`Thumbnail exceeds ${MAX_THUMBNAIL_BYTES} byte limit (${bytes.byteLength})`)
    }
    // Verify the version belongs to this workspace BEFORE writing the PNG.
    // Doing it the other way around would leave an orphan blob on disk for
    // any id that doesn't match (wrong workspace, deleted version, hostile
    // input) — the UPDATE would simply match zero rows and resolve while the
    // file sat at blobs/{ws}/versions/{id}.png with no DB pointer.
    const db = await dbReady()
    const owningCanvas = await db
      .selectFrom('versions')
      .innerJoin('canvases', 'canvases.id', 'versions.canvasId')
      .select(['versions.id'])
      .where('canvases.workspaceId', '=', workspaceId)
      .where('versions.id', '=', id)
      .executeTakeFirst()
    if (!owningCanvas) {
      throw new Error(`version "${id}" not found in workspace "${workspaceId}"`)
    }
    const path = thumbnailPath(workspaceId, id)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    await db.updateTable('versions').set({ hasThumbnail: 1 }).where('id', '=', id).execute()
  }

  async loadThumbnail(workspaceId: string, id: string): Promise<Uint8Array | null> {
    const path = thumbnailPath(workspaceId, id)
    try {
      const bytes = await readFile(path)
      return new Uint8Array(bytes)
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }
      throw corruptStoredData(path, `failed to read version thumbnail (${errorMessage(error)})`)
    }
  }

  async renameBranchInVersions(
    workspaceId: string,
    slug: string,
    oldName: string,
    newName: string,
  ): Promise<number> {
    validateWorkspaceId(workspaceId)
    validateSlug(slug)
    validateBranchName(oldName)
    validateBranchName(newName)
    if (oldName === newName) return 0
    const db = await dbReady()
    const canvasId = await getCanvasIdBySlug(db, workspaceId, slug)
    if (!canvasId) return 0
    const result = await db
      .updateTable('versions')
      .set({ branchName: newName })
      .where('canvasId', '=', canvasId)
      .where('branchName', '=', oldName)
      .executeTakeFirst()
    return Number(result.numUpdatedRows ?? 0)
  }

  async pruneSandwichedAutoVersions(
    workspaceId: string,
    slug: string,
  ): Promise<{ deletedCount: number; deletedIds: string[] }> {
    validateWorkspaceId(workspaceId)
    validateSlug(slug)
    const db = await dbReady()
    const canvasId = await getCanvasIdBySlug(db, workspaceId, slug)
    if (!canvasId) return { deletedCount: 0, deletedIds: [] }
    const rows = await db
      .selectFrom('versions')
      .select(['id', 'branchName', 'auto', 'createdAt'])
      .where('canvasId', '=', canvasId)
      .orderBy('branchName', 'asc')
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute()

    const toDelete: string[] = []
    const byBranch = new Map<string, typeof rows>()
    for (const row of rows) {
      const list = byBranch.get(row.branchName) ?? []
      list.push(row)
      byBranch.set(row.branchName, list)
    }
    for (const [, list] of byBranch) {
      // Find first/last manual indexes. With <2 manuals there is no
      // sandwich, so the branch is left untouched.
      let firstManualIdx = -1
      let lastManualIdx = -1
      for (let i = 0; i < list.length; i++) {
        if (list[i].auto !== 1) {
          if (firstManualIdx === -1) firstManualIdx = i
          lastManualIdx = i
        }
      }
      if (firstManualIdx === -1 || lastManualIdx === firstManualIdx) continue
      for (let i = firstManualIdx + 1; i < lastManualIdx; i++) {
        if (list[i].auto === 1) toDelete.push(list[i].id)
      }
    }
    if (toDelete.length === 0) return { deletedCount: 0, deletedIds: [] }
    await db
      .deleteFrom('versions')
      .where('canvasId', '=', canvasId)
      .where('id', 'in', toDelete)
      .execute()
    for (const id of toDelete) {
      const path = thumbnailPath(workspaceId, id)
      try {
        await unlink(path)
      } catch (err) {
        if (!isMissingFileError(err)) {
          getLogger('version-store prune-sandwiched').error(
            { path, err: err as Error },
            'failed to remove thumbnail',
          )
        }
      }
    }
    return { deletedCount: toDelete.length, deletedIds: toDelete }
  }

  async getFrontiersBase64(workspaceId: string, id: string): Promise<string | null> {
    validateWorkspaceId(workspaceId)
    validateVersionId(id)
    const db = await dbReady()
    const row = await db
      .selectFrom('versions')
      .innerJoin('canvases', 'canvases.id', 'versions.canvasId')
      .select(['versions.frontiers'])
      .where('canvases.workspaceId', '=', workspaceId)
      .where('versions.id', '=', id)
      .executeTakeFirst()
    return row?.frontiers ?? null
  }

  async earliestFrontiers(workspaceId: string, slug: string): Promise<Frontiers | null> {
    validateWorkspaceId(workspaceId)
    validateSlug(slug)
    const db = await dbReady()
    const canvasId = await getCanvasIdBySlug(db, workspaceId, slug)
    if (!canvasId) return null
    const row = await db
      .selectFrom('versions')
      .select(['frontiers'])
      .where('canvasId', '=', canvasId)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .limit(1)
      .executeTakeFirst()
    if (!row) return null
    try {
      return decodeFrontiers(base64ToBytes(row.frontiers))
    } catch (error) {
      throw corruptStoredData(
        `versions/${slug}`,
        `frontiers could not be decoded (${errorMessage(error)})`,
      )
    }
  }

  private async prune(workspaceId: string, canvasId: string): Promise<void> {
    const db = await dbReady()
    const autos = await db
      .selectFrom('versions')
      .select(['id'])
      .where('canvasId', '=', canvasId)
      .where('auto', '=', 1)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute()
    if (autos.length <= MAX_AUTO_PER_CANVAS) return
    const toRemove = autos.slice(MAX_AUTO_PER_CANVAS).map((r) => r.id)
    if (toRemove.length === 0) return
    await db
      .deleteFrom('versions')
      .where('canvasId', '=', canvasId)
      .where('id', 'in', toRemove)
      .execute()
    for (const id of toRemove) {
      const path = thumbnailPath(workspaceId, id)
      try {
        await unlink(path)
      } catch (error) {
        if (!isMissingFileError(error)) {
          getLogger('version-store prune').error(
            { path, err: error as Error },
            'failed to remove thumbnail',
          )
        }
      }
    }
  }
}
