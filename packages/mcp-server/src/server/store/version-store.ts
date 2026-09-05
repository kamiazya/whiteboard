import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  autoVersionsOverCap,
  MAX_AUTO_PER_DOCUMENT,
  sandwichedAutoVersionIds,
} from '@kamiazya/whiteboard-history'
import {
  projectWorkspaceDocument,
  resolveWorkspaceDocument,
} from '@kamiazya/whiteboard-loro-adapter'
import { countAliveNodes } from '@kamiazya/whiteboard-server-core'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import type { Frontiers } from 'loro-crdt'
import { decodeFrontiers, encodeFrontiers, LoroDoc } from 'loro-crdt'
import { nanoid } from 'nanoid'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import {
  validateBranchName,
  validateDocumentPath,
  validateVersionId,
  validateWorkspaceId,
} from '../validators.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { DocumentNotFoundError } from './document-not-found-error.js'
import { LibsqlDocumentStore } from './libsql/libsql-document-store.js'
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

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

// z.infer of the shared wire schema, not a hand-written twin: a separately
// written interface beside a Zod schema is the drift recipe the Zod
// discipline names, and this pair had three copies of one shape.
import type {
  OperatorInfo,
  VersionEntry,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { errorMessage } from '../../shared/error-message.js'

export type { OperatorInfo, VersionEntry }

export interface VersionStore {
  save(
    workspaceId: string,
    path: string,
    doc: LoroDoc,
    opts: {
      auto: boolean
      label?: string
      branchName?: string
      operator?: OperatorInfo
      /** The version this point was produced by restoring; see `versionEntrySchema`. */
      restoredFrom?: string
    },
  ): Promise<VersionEntry>
  // Returns an independent past-state doc: the stored workspace record
  // checked out at the version's frontiers, projected back to a standalone
  // per-document doc. Null only for a missing version.
  load(workspaceId: string, id: string): Promise<LoroDoc | null>
  /**
   * The whole WORKSPACE document checked out at this version — the input a
   * subtree rollback walks. Null only for a missing version.
   */
  loadWorkspaceAt(workspaceId: string, id: string): Promise<LoroDoc | null>
  list(workspaceId: string, path: string): Promise<VersionEntry[]>
  // `path` is the document the caller is asking ABOUT, and both refuse a
  // version another document owns — the refusal `loadPast` and restore
  // already make, for the same reason: an id alone must not reach a history
  // that is not this document's.
  saveThumbnail(workspaceId: string, path: string, id: string, bytes: Uint8Array): Promise<void>
  loadThumbnail(workspaceId: string, path: string, id: string): Promise<Uint8Array | null>
  // Frontiers of the oldest retained WORKSPACE-SCOPED version anywhere in the
  // workspace — the earliest point any version checkout still needs from the
  // workspace record's history, so the safe cut for compacting that record.
  // Null when the workspace has no scoped versions (compacting would then
  // risk history nothing has measured the need for).
  earliestWorkspaceFrontiers(workspaceId: string): Promise<Frontiers | null>
  // Public API used when creating branches from a version id.
  // Returns null only when the version is missing.
  getFrontiersBase64(workspaceId: string, id: string): Promise<string | null>
  // Rewrite branchName from oldName to newName for all versions of the given
  // path. Returns the number of rewritten rows.
  renameBranchInVersions(
    workspaceId: string,
    path: string,
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
    path: string,
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

// Exported so document-store's deleteDocument can unlink a canvas's version
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

async function dbReady() {
  await prepareDataDir(getDataDir())
  return getDb(getDataDir())
}

interface VersionRow {
  id: string
  documentId: string
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
  restoredFrom: string | null
  // The store hydrates this from the documents row at list time so callers
  // still see a path field on each entry.
  path: string
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
    path: row.path,
    createdAt: new Date(row.createdAt).toISOString(),
    elementCount: row.elementCount,
    auto: row.auto === 1,
    branchName: row.branchName,
    hasThumbnail: row.hasThumbnail === 1,
    ...(row.label !== null ? { label: row.label } : {}),
    ...(operator !== undefined ? { operator } : {}),
    ...(row.restoredFrom !== null ? { restoredFrom: row.restoredFrom } : {}),
  }
}

export class FileVersionStore implements VersionStore {
  async save(
    workspaceId: string,
    path: string,
    doc: LoroDoc,
    opts: {
      auto: boolean
      label?: string
      branchName?: string
      operator?: OperatorInfo
      /** The version this point was produced by restoring; see `versionEntrySchema`. */
      restoredFrom?: string
    },
  ): Promise<VersionEntry> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
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

      const createdAt = Date.now()
      const operator = opts.operator

      const db = await dbReady()
      // A document's checkpoint lives in the WORKSPACE document's oplog:
      // that lineage is durable across restarts, while a projection's is
      // reborn per process — frontiers recorded against it would break on
      // the first daemon restart. The stored record (not a cache) is read,
      // because a checkpoint must point at persisted ops — and it is also
      // the address book now (S7): the path resolves in the tree, with no
      // documents-row lookup left.
      const storedWorkspace = await new DocumentStoreWorkspaceDocs(
        new LibsqlDocumentStore(db),
      ).open(workspaceId)
      const entry =
        storedWorkspace === null ? null : resolveWorkspaceDocument(storedWorkspace, path)
      if (storedWorkspace === null || entry === null) {
        throw new DocumentNotFoundError(workspaceId, path)
      }
      const documentId = entry.documentId
      const frontiers = bytesToBase64(encodeFrontiers(storedWorkspace.frontiers()))
      await db
        .insertInto('versions')
        .values({
          id,
          documentId,
          workspaceId,
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
          restoredFrom: opts.restoredFrom ?? null,
        })
        .execute()

      await this.prune(workspaceId, documentId)

      return {
        id,
        path,
        createdAt: new Date(createdAt).toISOString(),
        elementCount,
        auto: opts.auto,
        branchName,
        hasThumbnail: false,
        ...(opts.label !== undefined ? { label: opts.label } : {}),
        ...(operator !== undefined ? { operator } : {}),
        ...(opts.restoredFrom !== undefined ? { restoredFrom: opts.restoredFrom } : {}),
      }
    })
  }

  async load(workspaceId: string, id: string): Promise<LoroDoc | null> {
    validateWorkspaceId(workspaceId)
    validateVersionId(id)
    const db = await dbReady()
    const row = await db
      .selectFrom('versions')
      .select(['frontiers', 'documentId'])
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) return null
    // Checked out against the STORED workspace document, whose oplog the
    // frontiers were recorded in — never against a live per-document
    // projection, whose fresh lineage does not contain them. The past state
    // is then projected back out as a standalone doc, which is the shape
    // every caller expects.
    const storedWorkspace = await new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)).open(
      workspaceId,
    )
    if (storedWorkspace === null) {
      throw corruptStoredData(
        `versions/${id}`,
        'workspace-scoped version has no stored workspace document to check out against',
      )
    }
    const clone = LoroDoc.fromSnapshot(storedWorkspace.export({ mode: 'snapshot' }))
    try {
      clone.checkout(decodeFrontiers(base64ToBytes(row.frontiers)))
    } catch (error) {
      throw corruptStoredData(
        `versions/${id}`,
        `frontiers could not be checked out against the workspace document (${errorMessage(error)})`,
      )
    }
    return projectWorkspaceDocument(clone, row.documentId)
  }

  async loadWorkspaceAt(workspaceId: string, id: string): Promise<LoroDoc | null> {
    validateWorkspaceId(workspaceId)
    validateVersionId(id)
    const db = await dbReady()
    const row = await db
      .selectFrom('versions')
      .select(['frontiers'])
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) return null
    const storedWorkspace = await new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)).open(
      workspaceId,
    )
    if (storedWorkspace === null) return null
    const clone = LoroDoc.fromSnapshot(storedWorkspace.export({ mode: 'snapshot' }))
    try {
      clone.checkout(decodeFrontiers(base64ToBytes(row.frontiers)))
    } catch (error) {
      throw corruptStoredData(
        `versions/${id}`,
        `frontiers could not be checked out against the workspace document (${errorMessage(error)})`,
      )
    }
    return clone
  }

  async list(workspaceId: string, path: string): Promise<VersionEntry[]> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
    const db = await dbReady()
    const documentId = await this.resolveDocumentId(db, workspaceId, path)
    if (!documentId) return []
    const rows = await db
      .selectFrom('versions')
      .selectAll()
      .where('documentId', '=', documentId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute()
    return rows.map((r) => rowToEntry({ ...r, path } as VersionRow))
  }

  /**
   * Whether `id` is a version of the document at `path` — the one place the
   * picture routes ask it, so a read and a write cannot come to different
   * answers about who owns a version.
   */
  private async ownsVersion(workspaceId: string, path: string, id: string): Promise<boolean> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
    const db = await dbReady()
    const documentId = await this.resolveDocumentId(db, workspaceId, path)
    if (!documentId) return false
    const row = await db
      .selectFrom('versions')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .where('documentId', '=', documentId)
      .where('id', '=', id)
      .executeTakeFirst()
    return row !== undefined
  }

  async saveThumbnail(
    workspaceId: string,
    path: string,
    id: string,
    bytes: Uint8Array,
  ): Promise<void> {
    validateVersionId(id)
    if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
      throw new Error(`Thumbnail exceeds ${MAX_THUMBNAIL_BYTES} byte limit (${bytes.byteLength})`)
    }
    // Verify the version belongs to this DOCUMENT before writing the PNG.
    // Doing it the other way around would leave an orphan blob on disk for
    // any id that doesn't match (wrong document, deleted version, hostile
    // input) — the UPDATE would simply match zero rows and resolve while the
    // file sat at blobs/{ws}/versions/{id}.png with no DB pointer.
    if (!(await this.ownsVersion(workspaceId, path, id))) {
      throw new Error(`version "${id}" not found at "${path}" in workspace "${workspaceId}"`)
    }
    const db = await dbReady()
    const blobPath = thumbnailPath(workspaceId, id)
    await mkdir(dirname(blobPath), { recursive: true })
    await writeFile(blobPath, bytes)
    await db.updateTable('versions').set({ hasThumbnail: 1 }).where('id', '=', id).execute()
  }

  async loadThumbnail(workspaceId: string, path: string, id: string): Promise<Uint8Array | null> {
    // The path is built FIRST, because building it is what asserts the id
    // cannot escape `blobs/` — the second line of defence behind
    // validateVersionId, and it has to fire on a hostile id whether or not
    // any version owns it.
    const blobPath = thumbnailPath(workspaceId, id)
    // Absent, not refused: a picture this document does not own reads the
    // same to a caller as one that was never taken, which is what
    // `loadPast`'s `null` already says for the state itself.
    if (!(await this.ownsVersion(workspaceId, path, id))) return null
    try {
      const bytes = await readFile(blobPath)
      return new Uint8Array(bytes)
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }
      throw corruptStoredData(blobPath, `failed to read version thumbnail (${errorMessage(error)})`)
    }
  }

  async renameBranchInVersions(
    workspaceId: string,
    path: string,
    oldName: string,
    newName: string,
  ): Promise<number> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
    validateBranchName(oldName)
    validateBranchName(newName)
    if (oldName === newName) return 0
    const db = await dbReady()
    const documentId = await this.resolveDocumentId(db, workspaceId, path)
    if (!documentId) return 0
    const result = await db
      .updateTable('versions')
      .set({ branchName: newName })
      .where('documentId', '=', documentId)
      .where('branchName', '=', oldName)
      .executeTakeFirst()
    return Number(result.numUpdatedRows ?? 0)
  }

  async pruneSandwichedAutoVersions(
    workspaceId: string,
    path: string,
  ): Promise<{ deletedCount: number; deletedIds: string[] }> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
    const db = await dbReady()
    const documentId = await this.resolveDocumentId(db, workspaceId, path)
    if (!documentId) return { deletedCount: 0, deletedIds: [] }
    const rows = await db
      .selectFrom('versions')
      .select(['id', 'branchName', 'auto', 'createdAt'])
      .where('documentId', '=', documentId)
      .orderBy('branchName', 'asc')
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute()

    // Which rows go is the mechanic's call (@kamiazya/whiteboard-history);
    // the rows, the delete and the thumbnail blobs are this store's.
    const toDelete = sandwichedAutoVersionIds(
      rows.map((row) => ({ id: row.id, branchName: row.branchName, auto: row.auto === 1 })),
    )
    if (toDelete.length === 0) return { deletedCount: 0, deletedIds: [] }
    await db
      .deleteFrom('versions')
      .where('documentId', '=', documentId)
      .where('id', 'in', toDelete)
      .execute()
    for (const id of toDelete) {
      const blobPath = thumbnailPath(workspaceId, id)
      try {
        await unlink(blobPath)
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
      .select(['frontiers'])
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', id)
      .executeTakeFirst()
    return row?.frontiers ?? null
  }

  async earliestWorkspaceFrontiers(workspaceId: string): Promise<Frontiers | null> {
    validateWorkspaceId(workspaceId)
    const db = await dbReady()
    const row = await db
      .selectFrom('versions')
      .select(['frontiers'])
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .limit(1)
      .executeTakeFirst()
    if (!row) return null
    try {
      return decodeFrontiers(base64ToBytes(row.frontiers))
    } catch (error) {
      throw corruptStoredData(
        `versions/${workspaceId}`,
        `frontiers could not be decoded (${errorMessage(error)})`,
      )
    }
  }

  // The stored record is the address book (S7). ponytail: opens the whole
  // record per call; route frequency is low, cache when a measured
  // workspace makes it slow.
  private async resolveDocumentId(
    db: Awaited<ReturnType<typeof dbReady>>,
    workspaceId: string,
    path: string,
  ): Promise<string | null> {
    const storedWorkspace = await new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)).open(
      workspaceId,
    )
    if (storedWorkspace === null) return null
    return resolveWorkspaceDocument(storedWorkspace, path)?.documentId ?? null
  }

  private async prune(workspaceId: string, documentId: string): Promise<void> {
    const db = await dbReady()
    const autos = await db
      .selectFrom('versions')
      .select(['id', 'restoredFrom'])
      .where('documentId', '=', documentId)
      .where('auto', '=', 1)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute()
    if (autos.length <= MAX_AUTO_PER_DOCUMENT) return
    // Lineage outlives the cap — the mechanic's rule
    // (@kamiazya/whiteboard-history's `autoVersionsOverCap`); the referenced
    // set is what this store knows about its own rows.
    const referenced = new Set(
      (
        await db
          .selectFrom('versions')
          .select(['restoredFrom'])
          .where('documentId', '=', documentId)
          .where('restoredFrom', 'is not', null)
          .execute()
      ).flatMap((r) => (r.restoredFrom === null ? [] : [r.restoredFrom])),
    )
    const toRemove = autoVersionsOverCap(autos, referenced)
    if (toRemove.length === 0) return
    await db
      .deleteFrom('versions')
      .where('documentId', '=', documentId)
      .where('id', 'in', toRemove)
      .execute()
    for (const id of toRemove) {
      const blobPath = thumbnailPath(workspaceId, id)
      try {
        await unlink(blobPath)
      } catch (error) {
        if (!isMissingFileError(error)) {
          getLogger('version-store prune').error(
            { path: blobPath, err: error as Error },
            'failed to remove thumbnail',
          )
        }
      }
    }
  }
}
