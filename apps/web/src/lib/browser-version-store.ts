import {
  operatorInfoSchema,
  type VersionEntry,
  versionEntrySchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { autoVersionsOverCap } from '@kamiazya/whiteboard-history'
import {
  type LeaseFileReferenceReads,
  lease,
  type RecordLease,
} from '@kamiazya/whiteboard-loro-adapter'
import { compareCodeUnit, generateDocumentId } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { z } from 'zod'
import { VERSIONS_BY_DOCUMENT_INDEX, VERSIONS_STORE } from './browser-idb.js'
import { inTransaction, request } from './idb-tx.js'
import { announceVersion } from './workspace-broadcast.js'
import { type HeldDocument, withHeldDocument } from './workspace-content.js'

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
     * Optional for a load-bearing reason: this schema is `.strict()` and
     * its reader SKIPS a row that fails to parse, so making this REQUIRED
     * would silently delete the whole history of anyone who has rows from
     * before it.
     * Absent reads as `false`, which is what every existing row is.
     */
    auto: z.boolean().optional(),
    frontiers: z.instanceof(Uint8Array),
    /**
     * The identity of the CONTENT this point was taken of, so "has this
     * document changed?" can be asked about the document rather than about
     * the record.
     *
     * REQUIRED, unlike `auto`, which is optional exactly because a row
     * written before it had to keep parsing. That reasoning
     * does not apply here: no row written before this one exists —
     * IndexedDB v19 emptied the store, because a past checkpoint's content is
     * reachable only by checking the record out at its own frontier and so
     * none could be backfilled. Requiring it is what keeps the read a single
     * comparison instead of a second path answering the old, wrong question.
     */
    contentDigest: z.string().min(1),
  })
  .strict()
export type VersionRow = z.infer<typeof versionRowSchema>

export interface BrowserVersionStoreDeps {
  /** The workspace record — where a frontier points and what a restore checks out. */
  readonly docs: WorkspaceDocs<RecordLease>
  /** Placement: path -> documentId, so a rename does not orphan a history. */
  readonly index: Pick<DocumentIndex, 'resolveDocument'>
  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  readonly dbName?: string
}

/**
 * What the live record held when a local edit was made, as the bytes the
 * checkpoint scheduler compares and never decodes. The version vector names
 * the same set of operations a frontier does, so two equal answers mean
 * nothing was added in between.
 *
 * A value rather than the record's lease: the scheduler keeps what it is
 * handed until its timer fires, long after the page that armed it may have
 * released the lease.
 */
export interface RecordPoint {
  readonly frontier: Uint8Array
}

export function recordPointOf(record: RecordLease): RecordPoint {
  return { frontier: lease.versionOf(record).encoded }
}

export function recordFrontier(point: RecordPoint): Uint8Array {
  return point.frontier
}

const fingerprintShape = z.custom<{
  contentDigest: { ok: string } | { err: string }
} | null>()

/**
 * The identity of the content a document holds in the record, read from the
 * record through the projection a keeper stores — never from the index, which
 * may not hold the content to derive one. `null` when the record holds no such
 * document.
 */
async function contentDigestIn(record: RecordLease, documentId: string): Promise<string | null> {
  const projection = await lease.read(
    record,
    { query: 'workspaceDocumentProjection', args: { documentId } },
    fingerprintShape,
  )
  if (projection === null) return null
  if ('err' in projection.contentDigest) {
    throw new Error(`the content of ${documentId} could not be digested`)
  }
  return projection.contentDigest.ok
}

/**
 * What a version row records of the stored record as it stands: the document's
 * content identity and size, and the frontiers that name this point. The
 * record is released whether it answers or not.
 */
async function pointOfRecord(record: RecordLease, documentId: string, path: string) {
  return lease.withLease(record, async (held) => {
    const contentDigest = await contentDigestIn(held, documentId)
    if (contentDigest === null) throw new Error(`no content for ${path} in the workspace record`)
    return {
      contentDigest,
      elementCount: await lease.read(
        held,
        { query: 'spatialNodeCount', args: { documentId } },
        z.number(),
      ),
      // The STORED record's frontier, never a live doc's: a checkpoint has to
      // point at ops that are on disk, and `open` reads what is.
      frontiers: new Uint8Array(lease.versionOf(held).encodedFrontiers),
    }
  })
}

/**
 * The browser keeper's version history — the twin of the daemon's
 * `FileVersionStore`, over IndexedDB.
 *
 * Same design, and for the same reason: a version is a FRONTIER of the
 * workspace record, whose lineage is durable — the fold re-snapshots the
 * same ops, so a frontier saved before any number of folds still checks
 * out after them. A per-document copy would be the second place to keep a
 * version, which is the defect the daemon's store had and removed.
 *
 * `withPast` lends the past state of ONE document, which is what a restore
 * reconciles from; who reconciles it onto the live document is the backend's
 * business (`BrowserBackend.applyRestore`).
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
    } = {},
  ): Promise<VersionEntry> {
    const placement = await this.deps.index.resolveDocument({ workspaceId, path })
    if (placement === null) throw new Error(`no document at ${path}`)
    const record = await this.deps.docs.open(workspaceId)
    if (record === null) throw new Error(`no workspace record for ${workspaceId}`)
    const { contentDigest, elementCount, frontiers } = await pointOfRecord(
      record,
      placement.documentId,
      path,
    )
    const row: VersionRow = {
      id: generateDocumentId(),
      workspaceId,
      documentId: placement.documentId,
      path,
      ...(input.label === undefined || input.label === '' ? {} : { label: input.label }),
      createdAt: Date.now(),
      elementCount,
      ...(input.operator === undefined ? {} : { operator: input.operator }),
      ...(input.restoredFrom === undefined ? {} : { restoredFrom: input.restoredFrom }),
      // Written only when true, so a manual save keeps writing exactly the
      // row it wrote before `auto` existed.
      ...(input.auto === true ? { auto: true } : {}),
      frontiers,
      // Taken from the RECORD, never from the index. `DocumentEntry`'s digest
      // is optional because an index that does not hold the content cannot
      // derive one, and this app's legacy rows were exactly that; depending on
      // it here meant a markdown note could not be checkpointed at all. The
      // record is the one place that always holds the content, and
      // `content-digest.hosts.test.ts` pins that a projection and the tree
      // node it came from answer the same digest.
      contentDigest,
    }
    await inTransaction(this.deps.dbName, [VERSIONS_STORE], 'readwrite', async (tx) => {
      await request(tx.objectStore(VERSIONS_STORE).put(versionRowSchema.parse(row)))
    })
    // Only a checkpoint can push the document over the cap, so only a
    // checkpoint pays for the sweep — a manual save reads no rows at all.
    if (input.auto === true) await this.pruneAutoOverCap(workspaceId, placement.documentId)
    return this.announced(workspaceId, placement.documentId, toEntry(row, path))
  }

  /**
   * Every tab on the document re-reads its history, this one included — the
   * daemon's version_created broadcast, for the browser keeper.
   */
  private announced(workspaceId: string, documentId: string, entry: VersionEntry): VersionEntry {
    announceVersion(workspaceId, documentId, entry)
    return entry
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
      .sort((a, b) => b.createdAt - a.createdAt || compareCodeUnit(b.id, a.id))
      .map((row) => ({ id: row.id, restoredFrom: row.restoredFrom ?? null }))
    const referenced = new Set(
      rows.flatMap((row) => (row.restoredFrom === undefined ? [] : [row.restoredFrom])),
    )
    const toRemove = autoVersionsOverCap(autosNewestFirst, referenced)
    if (toRemove.length === 0) return
    await inTransaction(this.deps.dbName, [VERSIONS_STORE], 'readwrite', async (tx) => {
      const versions = tx.objectStore(VERSIONS_STORE)
      for (const id of toRemove) await request(versions.delete(id))
    })
  }

  /**
   * Does the newest checkpoint already hold the state this document is in?
   *
   * Answered on the document's CONTENT, because a record frontier cannot
   * answer it: every document in a workspace lives in one record, so any
   * sibling's edit moves the frontier and the question comes back "somebody
   * edited something here". Measured on the daemon twin before the fix: five
   * sibling edits, five wrong answers. In a workspace anybody is working in,
   * that leaves the scheduler unable to tell an untouched document from an
   * edited one at all.
   *
   * The digest is a function of the MERGED content, not of a write stamp, so
   * two replicas that converged agree on it. Both halves stay in this store's
   * own space: the digest is derived on the same read of the record that
   * `save` derived the row's from.
   *
   * There is no second path for a row carrying no digest, because none is
   * left: IndexedDB v19 emptied this store of the rows written before the
   * field, and every row `save` writes carries one.
   *
   * Both digests come from the RECORD, through the same projection — never
   * from the index. `DocumentEntry.contentDigest` is optional precisely
   * because an index that does not hold the content cannot derive one, and
   * this app wires such an index; reading it here would make the answer
   * depend on which index a caller happened to pass.
   */
  async isUnchangedSinceLastVersion(workspaceId: string, path: string): Promise<boolean> {
    const placement = await this.deps.index.resolveDocument({ workspaceId, path })
    if (placement === null) return false
    const rows = await this.rowsOf(workspaceId, placement.documentId)
    const newest = rows.sort((a, b) => b.createdAt - a.createdAt || compareCodeUnit(b.id, a.id))[0]
    if (newest === undefined) return false
    const record = await this.deps.docs.open(workspaceId)
    if (record === null) return false
    const digest = await lease.withLease(record, (held) =>
      contentDigestIn(held, placement.documentId),
    )
    return digest !== null && newest.contentDigest === digest
  }

  /** Newest first, as the History panel lists them. */
  async list(workspaceId: string, path: string): Promise<VersionEntry[]> {
    const placement = await this.deps.index.resolveDocument({ workspaceId, path })
    if (placement === null) return []
    const rows = await this.rowsOf(workspaceId, placement.documentId)
    return rows
      .sort((a, b) => b.createdAt - a.createdAt || compareCodeUnit(b.id, a.id))
      .map((row) => toEntry(row, path))
  }

  /**
   * `use` over the past state of the document the version belongs to — the
   * record viewed at the version's frontier — or null when the version does not
   * exist, or its document did not yet. A version whose document is not `path`
   * is answered as absent, for the reason the daemon's operation refuses it:
   * the id alone would let another document's history be restored onto this
   * one. The view is released whether `use` returns or throws.
   */
  async withPast<T>(
    workspaceId: string,
    path: string,
    versionId: string,
    use: (held: HeldDocument) => Promise<T>,
  ): Promise<T | null> {
    const row = await this.ownedRow(workspaceId, path, versionId)
    if (row === null) return null
    const record = await this.deps.docs.open(workspaceId)
    if (record === null) return null
    return lease.withLease(record, (held) =>
      lease.withLease(lease.viewAt(held, row.frontiers), (past) =>
        withHeldDocument({ record: past, read: true }, row.documentId, use),
      ),
    )
  }

  /**
   * The row, but only if `path` is the document whose history it belongs to
   * — the refusal `withPast` makes, kept in one place so an id alone can
   * never reach another document's history through whichever reader was
   * written second.
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

function toEntry(row: VersionRow, path: string): VersionEntry {
  return versionEntrySchema.parse({
    id: row.id,
    path,
    createdAt: new Date(row.createdAt).toISOString(),
    elementCount: row.elementCount,
    auto: row.auto === true,
    ...(row.label === undefined ? {} : { label: row.label }),
    ...(row.operator === undefined ? {} : { operator: row.operator }),
    ...(row.restoredFrom === undefined ? {} : { restoredFrom: row.restoredFrom }),
  })
}

/**
 * Removes every saved version of one document — what a permanent delete from
 * the Trash owes the history that was kept so a restore could rejoin it.
 *
 * A function over the database rather than a method of the store: it needs no
 * placement (the document is gone, so nothing resolves its path) and no
 * workspace record, only the `[workspaceId, documentId]` the rows are keyed by.
 */
export async function deleteVersionRowsOfDocument(
  workspaceId: string,
  documentId: string,
  dbName?: string,
): Promise<void> {
  await inTransaction(dbName, [VERSIONS_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(VERSIONS_STORE)
    const ids = await request(
      store
        .index(VERSIONS_BY_DOCUMENT_INDEX)
        .getAllKeys(IDBKeyRange.only([workspaceId, documentId])),
    )
    for (const id of ids) await request(store.delete(id))
  })
}

/**
 * Removes every saved version of one workspace — what retiring a whole
 * browser-kept workspace owes its history once nothing can open the record
 * the frontiers point into.
 */
export async function deleteVersionRowsOfWorkspace(
  workspaceId: string,
  dbName?: string,
): Promise<void> {
  await inTransaction(dbName, [VERSIONS_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(VERSIONS_STORE)
    // Every `[workspaceId, documentId]`: an array key sorts after any string,
    // so `[workspaceId, []]` bounds them from above.
    const ids = await request(
      store
        .index(VERSIONS_BY_DOCUMENT_INDEX)
        .getAllKeys(IDBKeyRange.bound([workspaceId], [workspaceId, []])),
    )
    for (const id of ids) await request(store.delete(id))
  })
}

/**
 * Every saved version of one workspace, whole — what a move carries to the
 * keeper the workspace goes to, and what the file sweep checks out. A row that fails the schema is skipped
 * exactly as the History panel skips it: a version nobody can list is one
 * nobody can restore.
 */
export async function savedVersionRows(
  workspaceId: string,
  dbName?: string,
): Promise<readonly VersionRow[]> {
  const raw = await inTransaction(dbName, [VERSIONS_STORE], 'readonly', (tx) =>
    request(tx.objectStore(VERSIONS_STORE).getAll()),
  )
  return (raw as unknown[]).flatMap((value) => {
    const parsed = versionRowSchema.safeParse(value)
    return parsed.success && parsed.data.workspaceId === workspaceId ? [parsed.data] : []
  })
}

const imageRefIdsShape = z.array(z.string())

/**
 * `use` over the saved versions as `scanFileReferencesOfLease` reads them —
 * what the file sweep and a promotion check out to learn which images a past
 * state draws. One view of the record is moved from frontier to frontier
 * rather than one made per version: a view copies the whole workspace, and a
 * move re-reads the state of the one it has. The view is released whether
 * `use` returns or throws.
 */
export async function withSavedVersionReads<T>(
  record: RecordLease,
  rows: ReadonlyArray<Pick<VersionRow, 'id' | 'documentId' | 'frontiers'>>,
  use: (versions: NonNullable<LeaseFileReferenceReads['versions']>) => Promise<T>,
): Promise<T> {
  // Held in an object: the closure below assigns it, which narrowing cannot follow.
  const view: { past: RecordLease | null } = { past: null }
  try {
    return await use({
      list: (holder) =>
        Promise.resolve(
          rows.filter((row) => row.documentId === holder.documentId).map((row) => row.id),
        ),
      // Through `then`, so a move that throws rejects the way an async read would.
      imageRefIds: (holder, versionId) =>
        Promise.resolve().then(() => {
          const row = rows.find((candidate) => candidate.id === versionId)
          if (row === undefined) return null
          if (view.past === null) view.past = lease.viewAt(record, row.frontiers)
          else lease.moveView(view.past, row.frontiers)
          return lease.read(
            view.past,
            { query: 'imageRefIds', args: { documentId: holder.documentId } },
            imageRefIdsShape,
          )
        }),
    })
  } finally {
    view.past?.release()
  }
}
