/**
 * `DocumentIndex` over IndexedDB — the browser's twin of the daemon's
 * `SqliteDocumentIndex`, held to the same conformance suite.
 *
 * The port's heavy invariant is that a mutating operation "takes effect as one
 * indivisible operation or has no effect at all". The daemon buys that with an
 * in-process write lock around a SQL transaction; here a single IndexedDB
 * `readwrite` transaction gives it directly, and more cheaply — nothing else
 * can interleave inside one, including another tab. What that costs is
 * discipline about SCOPE: the check and the write have to name the same
 * transaction, or the guarantee is gone while the code still looks careful.
 */

import { generateDocumentId } from '@kamiazya/whiteboard-model'
import {
  type CreateDocumentInput,
  type CreateWorkspaceInput,
  compareDocumentPaths,
  type DeleteDocumentInput,
  type DocumentEntry,
  DocumentHasDescendantsError,
  type DocumentIndex,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
  findDescendantPath,
  isSelfOrDescendant,
  type ListDocumentsInput,
  type MoveDocumentInput,
  planSubtreeMove,
  type ResolveDocumentByIdInput,
  type ResolveDocumentInput,
  type SetDocumentNameInput,
  WorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import { DOCUMENT_INDEX_STORE, WORKSPACES_STORE } from './browser-idb.js'
import { inTransaction, request } from './idb-tx.js'

/**
 * A row as stored. `name` and `kind` are absent rather than null when unset,
 * matching `DocumentEntry` — IndexedDB round-trips `undefined` properties by
 * dropping them, so writing the entry shape directly keeps the read path free
 * of null-to-absent conversions the daemon's SQL twin has to perform.
 */
interface IndexRow {
  readonly workspaceId: string
  readonly documentId: string
  readonly path: string
  readonly kind?: DocumentEntry['kind']
  readonly name?: string
}

function toEntry(row: IndexRow): DocumentEntry {
  return {
    documentId: row.documentId,
    path: row.path,
    ...(row.kind === undefined ? {} : { kind: row.kind }),
    ...(row.name === undefined ? {} : { name: row.name }),
  }
}

async function requireWorkspace(tx: IDBTransaction, workspaceId: string): Promise<void> {
  const found = await request(tx.objectStore(WORKSPACES_STORE).getKey(workspaceId))
  if (found === undefined) throw new WorkspaceNotFoundError(workspaceId)
}

/** Every row in one workspace, unordered. */
async function rowsIn(tx: IDBTransaction, workspaceId: string): Promise<IndexRow[]> {
  const range = IDBKeyRange.bound([workspaceId], [workspaceId, []])
  return (await request(tx.objectStore(DOCUMENT_INDEX_STORE).getAll(range))) as IndexRow[]
}

export class IdbDocumentIndex implements DocumentIndex {
  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  constructor(private readonly dbName?: string) {}

  private tx<T>(
    stores: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    return inTransaction(this.dbName, stores, mode, body)
  }

  async createWorkspace({ workspaceId }: CreateWorkspaceInput): Promise<void> {
    await this.tx([WORKSPACES_STORE], 'readwrite', async (tx) => {
      // put, not add: creating one that exists is explicitly not an error.
      await request(tx.objectStore(WORKSPACES_STORE).put({ workspaceId }, workspaceId))
    })
  }

  async listWorkspaces(): Promise<{ workspaceId: string }[]> {
    return this.tx([WORKSPACES_STORE], 'readonly', async (tx) => {
      // The store is keyed by workspaceId, so the KEYS are the answer — no
      // value read, and nothing to go stale between the two.
      const keys = await request(tx.objectStore(WORKSPACES_STORE).getAllKeys())
      return keys.map((key) => ({ workspaceId: String(key) }))
    })
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentEntry> {
    const row: IndexRow = {
      workspaceId: input.workspaceId,
      documentId: generateDocumentId(),
      path: input.path,
      kind: input.kind,
      ...(input.name === undefined ? {} : { name: input.name }),
    }
    return this.tx([WORKSPACES_STORE, DOCUMENT_INDEX_STORE], 'readwrite', async (tx) => {
      await requireWorkspace(tx, input.workspaceId)
      try {
        // `add` rather than a read-then-write: claiming the path and assigning
        // the id is one step, so two creators racing the same path cannot both
        // see it free. The store's own key constraint is the check.
        await request(tx.objectStore(DOCUMENT_INDEX_STORE).add(row))
      } catch (err) {
        if (err instanceof DOMException && err.name === 'ConstraintError') {
          throw new DocumentPathTakenError(input.workspaceId, input.path)
        }
        throw err
      }
      return toEntry(row)
    })
  }

  async resolveDocument({
    workspaceId,
    path,
  }: ResolveDocumentInput): Promise<DocumentEntry | null> {
    return this.tx([DOCUMENT_INDEX_STORE], 'readonly', async (tx) => {
      const row = (await request(tx.objectStore(DOCUMENT_INDEX_STORE).get([workspaceId, path]))) as
        | IndexRow
        | undefined
      return row === undefined ? null : toEntry(row)
    })
  }

  async resolveDocumentById({
    workspaceId,
    documentId,
  }: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    return this.tx([DOCUMENT_INDEX_STORE], 'readonly', async (tx) => {
      // Keyed by [workspaceId, documentId], so an id from another workspace
      // misses rather than reaching across — the port calls an id a handle
      // within a workspace, not a capability.
      const row = (await request(
        tx.objectStore(DOCUMENT_INDEX_STORE).index('byId').get([workspaceId, documentId]),
      )) as IndexRow | undefined
      return row === undefined ? null : toEntry(row)
    })
  }

  async listDocuments({ workspaceId }: ListDocumentsInput): Promise<DocumentEntry[]> {
    return this.tx([WORKSPACES_STORE, DOCUMENT_INDEX_STORE], 'readonly', async (tx) => {
      // Before the rows, not after: an absent workspace answers with an error
      // rather than an empty list, which is the same answer a real but empty
      // workspace would give.
      await requireWorkspace(tx, workspaceId)
      const rows = await rowsIn(tx, workspaceId)
      // Sorted here rather than relying on the key order. The two agree today
      // — an array key sorts element-wise and `path` is the second element —
      // but the port ships `compareDocumentPaths` precisely so no store
      // re-derives the rule, and IndexedDB's collation is not that rule.
      return rows.sort((a, b) => compareDocumentPaths(a.path, b.path)).map(toEntry)
    })
  }

  async moveDocument({ workspaceId, from, to }: MoveDocumentInput): Promise<void> {
    // Before the transaction: this is a refusal about the request itself, not
    // something the stored rows could answer.
    if (isSelfOrDescendant(to, from)) throw new DocumentMoveIntoSelfError(from, to)

    await this.tx([WORKSPACES_STORE, DOCUMENT_INDEX_STORE], 'readwrite', async (tx) => {
      await requireWorkspace(tx, workspaceId)
      const rows = await rowsIn(tx, workspaceId)
      const plan = planSubtreeMove(
        rows.map((row) => ({ id: row.documentId, path: row.path })),
        from,
        to,
      )
      if (!plan.ok) {
        if (plan.reason === 'not-found') throw new DocumentNotFoundError(workspaceId, from)
        throw new DocumentPathTakenError(workspaceId, plan.path)
      }
      const byPath = new Map(rows.map((row) => [row.path, row]))
      const store = tx.objectStore(DOCUMENT_INDEX_STORE)
      // The plan's order is load-bearing (shallowest source first) because a
      // move up into its own ancestor namespace sends a deeper row onto a path
      // a shallower one is vacating. Delete-then-add per row, in that order,
      // for the same reason the daemon writes them one at a time.
      for (const move of plan.moves) {
        const row = byPath.get(move.from)
        if (row === undefined) continue
        await request(store.delete([workspaceId, move.from]))
        await request(store.add({ ...row, path: move.path }))
      }
    })
  }

  async setDocumentName({ workspaceId, documentId, name }: SetDocumentNameInput): Promise<void> {
    await this.tx([DOCUMENT_INDEX_STORE], 'readwrite', async (tx) => {
      const store = tx.objectStore(DOCUMENT_INDEX_STORE)
      const row = (await request(store.index('byId').get([workspaceId, documentId]))) as
        | IndexRow
        | undefined
      if (row === undefined) throw new DocumentNotFoundError(workspaceId, documentId)
      // Rebuilt rather than spread-with-undefined: a stored `name: undefined`
      // is not the same as an absent one to `'name' in entry`, which the
      // contract asserts on.
      const next: IndexRow = {
        workspaceId: row.workspaceId,
        documentId: row.documentId,
        path: row.path,
        ...(row.kind === undefined ? {} : { kind: row.kind }),
        ...(name === undefined ? {} : { name }),
      }
      await request(store.put(next))
    })
  }

  async deleteDocument({ workspaceId, path }: DeleteDocumentInput): Promise<void> {
    await this.tx([DOCUMENT_INDEX_STORE], 'readwrite', async (tx) => {
      const rows = await rowsIn(tx, workspaceId)
      const descendant = findDescendantPath(
        rows.map((row) => ({ id: row.documentId, path: row.path })),
        path,
      )
      if (descendant !== undefined) {
        // Same advice the daemon's twin gives, verbatim: a user meeting this
        // in one mode and then the other should not have to notice they are
        // different implementations.
        throw new DocumentHasDescendantsError(
          path,
          `Delete "${descendant}" and any others below it first.`,
        )
      }
      // Absent is fine — the caller wants it gone either way — so no existence
      // check precedes this.
      await request(tx.objectStore(DOCUMENT_INDEX_STORE).delete([workspaceId, path]))
    })
  }
}
