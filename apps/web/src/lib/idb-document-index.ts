/**
 * The browser's workspace registry and its legacy document rows, over
 * IndexedDB.
 *
 * Two roles, and only two. The REGISTRY — create, list, resolve and rename a
 * workspace — which `FoldingBrowserIndex` and the shell switcher
 * (`browser-workspaces.ts`) both keep here. And the legacy ROWS older builds
 * wrote one per document, which the startup fold lists and retires
 * (`fold-workspace.ts`). A document this build creates lives in the
 * workspace tree, never here, so nothing writes a row any more: this is not
 * a `DocumentIndex`, and a test that needs a legacy row writes one directly
 * (`test-utils/seed-legacy-row.ts`).
 *
 * Its writes still keep the `DocumentIndex` port's heavy invariant, that a
 * mutating operation "takes effect as one indivisible operation or has no
 * effect at all". The daemon buys that with an in-process per-workspace write
 * lock (`withWorkspaceWriteLock`) around a mutation of the workspace's Loro
 * tree; here a single IndexedDB `readwrite` transaction gives it directly,
 * and more cheaply — nothing else can interleave inside one, including
 * another tab. What that costs is discipline about SCOPE: the check and the
 * write have to name the same transaction, or the guarantee is gone while the
 * code still looks careful.
 */

import {
  type CreateWorkspaceInput,
  compareDocumentPaths,
  createWorkspaceInputSchema,
  type DocumentEntry,
  documentEntrySchema,
  type ListDocumentsInput,
  type RenameWorkspaceInput,
  type ResolveDocumentByIdInput,
  renameWorkspaceInputSchema,
  resolveWorkspaceHandle,
  storedWorkspaceEntrySchema,
  type WorkspaceEntry,
  WorkspaceNotFoundError,
  WorkspaceSegmentTakenError,
  workspaceEntrySchema,
} from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { getAppLogger } from './app-logger.js'
import { DOCUMENT_INDEX_STORE, WORKSPACES_STORE } from './browser-idb.js'
import { inTransaction, request } from './idb-tx.js'
import { indexWritesSettled, trackIndexWrite } from './pending-index-writes.js'

/**
 * A row as stored: the port's own entry shape plus the `workspaceId` the
 * store keys on. `name` and `kind` are absent rather than null when unset,
 * matching `DocumentEntry` — IndexedDB round-trips `undefined` properties by
 * dropping them, so writing the entry shape directly keeps the read path free
 * of null-to-absent conversions the daemon's SQL twin has to perform.
 *
 * Derived from `documentEntrySchema` rather than written beside it, and
 * every read below hydrates through it — the same discipline
 * `listWorkspaces` applies with `storedWorkspaceEntrySchema.parse`. A cast here
 * let a corrupt row (a devtools edit, a buggy writer, schema drift) flow
 * into the UI wearing the contract's type; the parse fails loudly and names
 * the field instead.
 */
const indexRowSchema = documentEntrySchema.extend({ workspaceId: z.string().min(1) })
type IndexRow = z.infer<typeof indexRowSchema>

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
  const rows = await request(tx.objectStore(DOCUMENT_INDEX_STORE).getAll(range))
  return rows.map((row) => indexRowSchema.parse(row))
}

const log = getAppLogger('idb-document-index')

/**
 * Hydrates one registry row through the port's READ schema, which reads a
 * layer the model refuses as absent rather than failing the list around it.
 * Said aloud when it happens: the stored row still carries the refused value
 * until a rename replaces it, and a silent drop would hide that.
 */
function readWorkspaceRow(value: unknown): WorkspaceEntry {
  const entry = storedWorkspaceEntrySchema.parse(value)
  if (!workspaceEntrySchema.safeParse(value).success) {
    // `info`, not `warn`: the read succeeded, and the row is the user's to
    // rename rather than a failure anything swallowed.
    log.info('read a workspace identity layer the model refuses as absent', {
      workspaceId: entry.workspaceId,
    })
  }
  return entry
}

export class IdbDocumentIndex {
  /**
   * `dbName`: only tests pass this; see `openWhiteboardDb`'s note on why it
   * exists. `readsAwaitIssuedWrites: false` is the startup fold's alone — see
   * `tx`.
   */
  constructor(
    private readonly dbName?: string,
    private readonly options: { readsAwaitIssuedWrites?: boolean } = {},
  ) {}

  private tx<T>(
    stores: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    // The one chokepoint for both directions, which is why the ordering rule
    // lives here rather than in each caller: a write is registered as
    // outstanding, and a read waits for the ones already issued. See
    // pending-index-writes.ts for what transaction ordering alone does not
    // cover. An empty set costs a read one microtask.
    if (mode === 'readwrite') {
      return trackIndexWrite(inTransaction(this.dbName, stores, mode, body))
    }
    // The fold reads without waiting because a tracked write can be what is
    // running it: the save loop's rename asks for the fold, and a fold read
    // that waited here would wait on that loop, which waits on the fold.
    if (this.options.readsAwaitIssuedWrites === false) {
      return inTransaction(this.dbName, stores, mode, body)
    }
    return indexWritesSettled().then(() => inTransaction(this.dbName, stores, mode, body))
  }

  /**
   * Parsed before the transaction opens, as the daemon parses at its
   * boundary: this store is a keeper's registry, and a row the model refuses
   * is one every later reader of it would have to tolerate.
   */
  async createWorkspace(input: CreateWorkspaceInput): Promise<void> {
    const { workspaceId, segment, displayName } = createWorkspaceInputSchema.parse(input)
    await this.tx([WORKSPACES_STORE], 'readwrite', async (tx) => {
      const store = tx.objectStore(WORKSPACES_STORE)
      // Creating one that exists is not an error — and not an overwrite. A
      // blind `put` of the input let the bare `{ workspaceId }` call clear
      // whatever identity layers the row already carried.
      //
      // Load-bearing for `FoldingBrowserIndex`, whose `createWorkspace`
      // writes its registry half through this call: `ensureBrowserWorkspace`
      // re-creates the browser workspace bare on every boot path, and an
      // overwrite here would strip the identity `renameWorkspace` — right
      // below, on this same store — had written.
      //
      // Read and return inside the SAME transaction, so the check and the
      // write cannot be split by a concurrent create.
      const existing = await request(store.get(workspaceId))
      if (existing !== undefined) return
      await request(
        store.put(
          {
            workspaceId,
            ...(segment === undefined ? {} : { segment }),
            ...(displayName === undefined ? {} : { displayName }),
          },
          workspaceId,
        ),
      )
    })
  }

  /**
   * Reads VALUES, not keys. The key alone was enough while `workspaceId` was
   * the only field a row had, but `segment` is what an address resolves
   * through and lives only in the value — a key-only read would answer every
   * row with its segment silently missing, which reads as "this workspace has
   * no segment" rather than as a read that did not look.
   *
   * A row written before the value carried those fields still lists: they are
   * optional in `workspaceEntrySchema` precisely because absent is a state a
   * workspace can be in. So does one written before the identity bounds, with
   * the refused layer absent — see `readWorkspaceRow`.
   */
  async listWorkspaces(): Promise<WorkspaceEntry[]> {
    return this.tx([WORKSPACES_STORE], 'readonly', async (tx) => {
      const rows = await request(tx.objectStore(WORKSPACES_STORE).getAll())
      return rows.map(readWorkspaceRow)
    })
  }

  async resolveWorkspace(handle: string): Promise<WorkspaceEntry | null> {
    return resolveWorkspaceHandle(await this.listWorkspaces(), handle)
  }

  /**
   * Read, check and write inside ONE readwrite transaction, so the
   * uniqueness check and the write it authorises cannot be separated. An
   * IndexedDB transaction is the only thing available here that makes that
   * true — there is no unique index on `segment` in this store, and a check
   * followed by a separate `put` would let two renames both find the segment
   * free.
   */
  async renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceEntry> {
    const { workspaceId, segment, displayName } = renameWorkspaceInputSchema.parse(input)
    return this.tx([WORKSPACES_STORE], 'readwrite', async (tx) => {
      const store = tx.objectStore(WORKSPACES_STORE)
      // Read tolerantly for the same reason a listing is: a rename is how a
      // row stored before the bounds gets repaired, so it must not be the
      // call that refuses to read that row.
      const rows = (await request(store.getAll())).map(readWorkspaceRow)
      const current = rows.find((row) => row.workspaceId === workspaceId)
      if (current === undefined) throw new WorkspaceNotFoundError(workspaceId)
      if (
        segment !== undefined &&
        rows.some((row) => row.segment === segment && row.workspaceId !== workspaceId)
      ) {
        throw new WorkspaceSegmentTakenError(segment)
      }
      const renamed: WorkspaceEntry = {
        ...current,
        ...(segment === undefined ? {} : { segment }),
        ...(displayName === undefined ? {} : { displayName }),
      }
      await request(store.put(renamed, workspaceId))
      return renamed
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

  /**
   * Drops the row naming `documentId`, whatever sits below its path. Not the
   * port's delete, which refuses a parent: this retires a row whose document
   * the workspace tree now answers for, and a row below it is retired on its
   * own turn. Absent is fine — a retirement interrupted after this ran
   * repeats it.
   */
  async retireDocument({ workspaceId, documentId }: ResolveDocumentByIdInput): Promise<void> {
    await this.tx([DOCUMENT_INDEX_STORE], 'readwrite', async (tx) => {
      const store = tx.objectStore(DOCUMENT_INDEX_STORE)
      const key = await request(store.index('byId').getKey([workspaceId, documentId]))
      if (key !== undefined) await request(store.delete(key))
    })
  }
}
