import {
  operatorInfoSchema,
  type VersionEntry,
  versionEntrySchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { autoVersionsOverCap } from '@kamiazya/whiteboard-history'
import { projectWorkspaceDocument, readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { decodeFrontiers, encodeFrontiers, LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import {
  VERSION_THUMBNAILS_STORE,
  VERSIONS_BY_DOCUMENT_INDEX,
  VERSIONS_STORE,
} from './browser-idb.js'
import { inTransaction, request } from './idb-tx.js'

/**
 * One saved version, as the `versions` store holds it. The frontier is the
 * checkpoint; everything else is the row the History panel lists. `path` is
 * the document's path AT SAVE TIME and is hydrated from the index on read,
 * so a renamed document keeps its history under its new name.
 */
const versionRowSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    documentId: z.string().min(1),
    path: z.string().min(1),
    label: z.string().optional(),
    createdAt: z.number().finite(),
    elementCount: z.number().int().min(0),
    operator: operatorInfoSchema.optional(),
    /** Set only on the point a restore produced; see `versionEntrySchema`. */
    restoredFrom: z.string().optional(),
    /**
     * Whether a checkpoint took this point rather than a person.
     *
     * Optional for the reason `hasThumbnail` is, and it is the load-bearing
     * reason on this schema: it is `.strict()` and its reader SKIPS a row
     * that fails to parse, so making either of these REQUIRED would silently
     * delete the whole history of anyone who has rows from before them.
     * Absent reads as `false`, which is what every existing row is.
     */
    auto: z.boolean().optional(),
    /** The variation HEAD was on when the point was taken; absent reads as `main`. */
    branchName: z.string().min(1).optional(),
    /**
     * Whether `versionThumbnails` holds a picture for this point. Optional
     * because rows written before v17 have none — and because this schema is
     * `.strict()` over rows the reader SKIPS when they fail to parse, so a
     * newly-required field would delete a reader's whole history rather than
     * fail loudly.
     */
    hasThumbnail: z.boolean().optional(),
    frontiers: z.instanceof(Uint8Array),
  })
  .strict()
type VersionRow = z.infer<typeof versionRowSchema>

export interface BrowserVersionStoreDeps {
  /** The workspace record — where a frontier points and what a restore checks out. */
  readonly docs: WorkspaceDocs
  /** Placement: path -> documentId, so a rename does not orphan a history. */
  readonly index: Pick<DocumentIndex, 'resolveDocument'>
  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  readonly dbName?: string
}

/**
 * The browser keeper's version history — the twin of the daemon's
 * `FileVersionStore`, over IndexedDB.
 *
 * Same design, and for the same reason: a version is a FRONTIER of the
 * workspace record, whose lineage is durable — the fold re-snapshots the
 * same ops, so a frontier saved before any number of folds still checks
 * out after them. A per-document copy would be the second place to keep a
 * version, which is the defect #1235 removed from the daemon.
 *
 * `loadPast` answers the past state of ONE document as a standalone doc,
 * which is what a restore reconciles from; who reconciles it onto the live
 * document is the backend's business (`BrowserBackend.applyRestore`).
 */
export class BrowserVersionStore {
  constructor(private readonly deps: BrowserVersionStoreDeps) {}

  async save(
    workspaceId: string,
    path: string,
    input: {
      label?: string
      operator?: VersionRow['operator']
      /** Records that this point is the merge a restore produced. */
      restoredFrom?: string
      /** A checkpoint took this point, not a person. */
      auto?: boolean
      /** The variation HEAD was on. Omitted leaves the row on the default one. */
      branchName?: string
    } = {},
  ): Promise<VersionEntry> {
    const placement = await this.deps.index.resolveDocument({ workspaceId, path })
    if (placement === null) throw new Error(`no document at ${path}`)
    const record = await this.deps.docs.open(workspaceId)
    if (record === null) throw new Error(`no workspace record for ${workspaceId}`)
    const projection = projectWorkspaceDocument(record, placement.documentId)
    const row: VersionRow = {
      id: generateDocumentId(),
      workspaceId,
      documentId: placement.documentId,
      path,
      ...(input.label === undefined || input.label === '' ? {} : { label: input.label }),
      createdAt: Date.now(),
      elementCount: projection === null ? 0 : countNodes(projection),
      ...(input.operator === undefined ? {} : { operator: input.operator }),
      ...(input.restoredFrom === undefined ? {} : { restoredFrom: input.restoredFrom }),
      // Written only when true / named, so a manual save on the default
      // variation keeps writing exactly the row it wrote before this existed.
      ...(input.auto === true ? { auto: true } : {}),
      ...(input.branchName === undefined || input.branchName === ''
        ? {}
        : { branchName: input.branchName }),
      // The STORED record's frontier, never a live doc's: a checkpoint has to
      // point at ops that are on disk, and `open` reads what is.
      frontiers: new Uint8Array(encodeFrontiers(record.oplogFrontiers())),
    }
    await inTransaction(this.deps.dbName, [VERSIONS_STORE], 'readwrite', async (tx) => {
      await request(tx.objectStore(VERSIONS_STORE).put(versionRowSchema.parse(row)))
    })
    // Only a checkpoint can push the document over the cap, so only a
    // checkpoint pays for the sweep — a manual save reads no rows at all.
    if (input.auto === true) await this.pruneAutoOverCap(workspaceId, placement.documentId)
    return toEntry(row, path)
  }

  /**
   * Drop the automatic checkpoints past the cap, newest kept.
   *
   * Which rows go is the mechanic's call
   * (`@kamiazya/whiteboard-history`'s `autoVersionsOverCap`, the same one the
   * daemon asks); the rows, the delete and the thumbnail blobs are this
   * store's. `referenced` is built over EVERY row rather than the automatic
   * ones, because a manual save can be a restore's merge point too and the
   * point it names must outlive the cap either way.
   */
  private async pruneAutoOverCap(workspaceId: string, documentId: string): Promise<void> {
    const rows = await this.rowsOf(workspaceId, documentId)
    const autosNewestFirst = rows
      .filter((row) => row.auto === true)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map((row) => ({ id: row.id, restoredFrom: row.restoredFrom ?? null }))
    const referenced = new Set(
      rows.flatMap((row) => (row.restoredFrom === undefined ? [] : [row.restoredFrom])),
    )
    const toRemove = autoVersionsOverCap(autosNewestFirst, referenced)
    if (toRemove.length === 0) return
    await inTransaction(
      this.deps.dbName,
      [VERSIONS_STORE, VERSION_THUMBNAILS_STORE],
      'readwrite',
      async (tx) => {
        const versions = tx.objectStore(VERSIONS_STORE)
        const thumbnails = tx.objectStore(VERSION_THUMBNAILS_STORE)
        for (const id of toRemove) {
          await request(versions.delete(id))
          // A point with no picture deletes nothing, which IndexedDB treats
          // as success — so this needs no existence check.
          await request(thumbnails.delete(id))
        }
      },
    )
  }

  /** Newest first, as the History panel lists them. */
  async list(workspaceId: string, path: string): Promise<VersionEntry[]> {
    const placement = await this.deps.index.resolveDocument({ workspaceId, path })
    if (placement === null) return []
    const rows = await this.rowsOf(workspaceId, placement.documentId)
    return rows
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map((row) => toEntry(row, path))
  }

  /**
   * The past state of the document the version belongs to, as an
   * independent doc — the record checked out at the version's frontier and
   * projected. Null only when the version does not exist. A version whose
   * document is not `path` is answered as absent, for the reason the
   * daemon's operation refuses it: the id alone would let another
   * document's history be restored onto this one.
   */
  async loadPast(workspaceId: string, path: string, versionId: string): Promise<LoroDoc | null> {
    const row = await this.ownedRow(workspaceId, path, versionId)
    if (row === null) return null
    const record = await this.deps.docs.open(workspaceId)
    if (record === null) return null
    const clone = LoroDoc.fromSnapshot(record.export({ mode: 'snapshot' }))
    clone.checkout(decodeFrontiers(row.frontiers))
    return projectWorkspaceDocument(clone, row.documentId)
  }

  /**
   * Keep the picture drawn for a saved point, and record on the row that
   * there is one.
   *
   * Two stores in one transaction, so a row can never claim a picture the
   * other store does not hold. The daemon's twin is a PUT to
   * `versions/:id/thumbnail`; what differs is only where the bytes land.
   */
  async putThumbnail(
    workspaceId: string,
    path: string,
    versionId: string,
    blob: Blob,
  ): Promise<void> {
    const row = await this.ownedRow(workspaceId, path, versionId)
    if (row === null) throw new Error(`no such version: ${versionId}`)
    await inTransaction(
      this.deps.dbName,
      [VERSIONS_STORE, VERSION_THUMBNAILS_STORE],
      'readwrite',
      async (tx) => {
        await request(tx.objectStore(VERSION_THUMBNAILS_STORE).put(blob, versionId))
        await request(
          tx
            .objectStore(VERSIONS_STORE)
            .put(versionRowSchema.parse({ ...row, hasThumbnail: true })),
        )
      },
    )
  }

  /** The picture, or null when there is none — or when the version is not this document's. */
  async loadThumbnail(workspaceId: string, path: string, versionId: string): Promise<Blob | null> {
    if ((await this.ownedRow(workspaceId, path, versionId)) === null) return null
    const blob = await inTransaction(
      this.deps.dbName,
      [VERSION_THUMBNAILS_STORE],
      'readonly',
      async (tx) => request(tx.objectStore(VERSION_THUMBNAILS_STORE).get(versionId)),
    )
    return blob instanceof Blob ? blob : null
  }

  /**
   * The row, but only if `path` is the document whose history it belongs to
   * — the refusal `loadPast` makes, in the one place both it and the picture
   * reads can share, so an id alone can never reach another document's
   * history through whichever of them was written second.
   */
  private async ownedRow(
    workspaceId: string,
    path: string,
    versionId: string,
  ): Promise<VersionRow | null> {
    const placement = await this.deps.index.resolveDocument({ workspaceId, path })
    if (placement === null) return null
    const row = await this.rowById(versionId)
    if (
      row === null ||
      row.workspaceId !== workspaceId ||
      row.documentId !== placement.documentId
    ) {
      return null
    }
    return row
  }

  private async rowsOf(workspaceId: string, documentId: string): Promise<VersionRow[]> {
    return inTransaction(this.deps.dbName, [VERSIONS_STORE], 'readonly', async (tx) => {
      const raw = await request(
        tx
          .objectStore(VERSIONS_STORE)
          .index(VERSIONS_BY_DOCUMENT_INDEX)
          .getAll(IDBKeyRange.only([workspaceId, documentId])),
      )
      // A row that does not parse is skipped rather than fatal: one bad row
      // must not hide a document's whole history.
      return (raw as unknown[]).flatMap((value) => {
        const parsed = versionRowSchema.safeParse(value)
        return parsed.success ? [parsed.data] : []
      })
    })
  }

  private async rowById(id: string): Promise<VersionRow | null> {
    return inTransaction(this.deps.dbName, [VERSIONS_STORE], 'readonly', async (tx) => {
      const raw = await request(tx.objectStore(VERSIONS_STORE).get(id))
      const parsed = versionRowSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    })
  }
}

function countNodes(doc: LoroDoc): number {
  try {
    return readSpatialCanvas(doc).nodes.length
  } catch {
    // A markdown document has no canvas to count; the advisory count is 0.
    return 0
  }
}

function toEntry(row: VersionRow, path: string): VersionEntry {
  return versionEntrySchema.parse({
    id: row.id,
    path,
    createdAt: new Date(row.createdAt).toISOString(),
    elementCount: row.elementCount,
    auto: row.auto === true,
    hasThumbnail: row.hasThumbnail === true,
    branchName: row.branchName ?? 'main',
    ...(row.label === undefined ? {} : { label: row.label }),
    ...(row.operator === undefined ? {} : { operator: row.operator }),
    ...(row.restoredFrom === undefined ? {} : { restoredFrom: row.restoredFrom }),
  })
}
