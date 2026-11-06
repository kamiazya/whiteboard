/**
 * The browser's workspace registry, over IndexedDB, and the probe for the
 * per-document rows older builds wrote.
 *
 * The REGISTRY — create, list, resolve and rename a workspace — is what
 * `BrowserDocumentIndex` and the shell switcher (`browser-workspaces.ts`)
 * both keep here. The per-document rows are not read: a document this build
 * creates lives in the workspace tree, and a workspace that still holds one
 * of those rows is refused whole (`holdsPreTreeRecords`). So this is not a
 * `DocumentIndex`, and a test that needs such a row writes one directly
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

import { SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import {
  type CreateWorkspaceInput,
  createWorkspaceInputSchema,
  type RenameWorkspaceInput,
  renameWorkspaceInputSchema,
  resolveWorkspaceHandle,
  storedWorkspaceEntrySchema,
  type WorkspaceEntry,
  WorkspaceNotFoundError,
  WorkspaceNotHeldError,
  WorkspaceSegmentTakenError,
  workspaceEntrySchema,
  workspaceIdOfStoredDocKey,
} from '@kamiazya/whiteboard-ports'
import { getAppLogger } from './app-logger.js'
import { DOCUMENT_INDEX_STORE, SYNC_DOCUMENTS_STORE, WORKSPACES_STORE } from './browser-idb.js'
import { inTransaction, request } from './idb-tx.js'
import { indexWritesSettled, trackIndexWrite } from './pending-index-writes.js'
import { refuseIfRemovedIn, TOMBSTONE_STORE } from './workspace-tombstone.js'

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
   * exists. `readsAwaitIssuedWrites: false` is for reads a tracked writer can
   * reach — `BrowserDocumentIndex`'s own — see `tx`.
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
    // Some reads go without waiting because a tracked write can be what is
    // running them: the save loop's rename asks whether its workspace is
    // refused, and a probe that waited here would wait on that loop, which
    // waits on the probe.
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
    const { workspaceId, namespace, segment, displayName } = createWorkspaceInputSchema.parse(input)
    await this.tx([WORKSPACES_STORE, TOMBSTONE_STORE], 'readwrite', async (tx) => {
      // A removed workspace is not "never created": a tab still holding its
      // id would otherwise register it again (`workspace-tombstone.ts`).
      await refuseIfRemovedIn(tx, workspaceId)
      const store = tx.objectStore(WORKSPACES_STORE)
      // Creating one that exists is not an error — and not an overwrite. A
      // blind `put` of the input let the bare `{ workspaceId }` call clear
      // whatever identity layers the row already carried.
      //
      // Load-bearing for `BrowserDocumentIndex`, whose `createWorkspace`
      // writes its registry half through this call: `ensureBrowserWorkspace`
      // re-creates the browser workspace bare on every boot path, and an
      // overwrite here would strip the identity `renameWorkspace` — right
      // below, on this same store — had written.
      //
      // Read and return inside the SAME transaction, so the check and the
      // write cannot be split by a concurrent create.
      const existing = await request(store.get(workspaceId))
      if (existing !== undefined) return
      // `put` takes anything and the reader drops a key it does not know, so
      // the row is checked here. Each layer carries its own `satisfies`: a
      // conditional spread escapes the excess-property check the outer
      // annotation would otherwise make.
      const entry: WorkspaceEntry = {
        workspaceId,
        ...(namespace === undefined ? {} : ({ namespace } satisfies Partial<WorkspaceEntry>)),
        ...(segment === undefined ? {} : ({ segment } satisfies Partial<WorkspaceEntry>)),
        ...(displayName === undefined ? {} : ({ displayName } satisfies Partial<WorkspaceEntry>)),
      }
      await request(store.put(entry, workspaceId))
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
    const { workspaceId, heldBy, segment, displayName } = renameWorkspaceInputSchema.parse(input)
    return this.tx([WORKSPACES_STORE], 'readwrite', async (tx) => {
      const store = tx.objectStore(WORKSPACES_STORE)
      // Read tolerantly for the same reason a listing is: a rename is how a
      // row stored before the bounds gets repaired, so it must not be the
      // call that refuses to read that row.
      const rows = (await request(store.getAll())).map(readWorkspaceRow)
      const current = rows.find((row) => row.workspaceId === workspaceId)
      if (current === undefined) throw new WorkspaceNotFoundError(workspaceId)
      if (heldBy !== undefined && (current.namespace ?? SINGLE_PERSON_NAMESPACE) !== heldBy) {
        throw new WorkspaceNotHeldError(workspaceId, heldBy)
      }
      if (
        segment !== undefined &&
        rows.some((row) => row.segment === segment && row.workspaceId !== workspaceId)
      ) {
        throw new WorkspaceSegmentTakenError(segment)
      }
      // Per-layer `satisfies` for the reason `createWorkspace` gives.
      const renamed: WorkspaceEntry = {
        ...current,
        ...(segment === undefined ? {} : ({ segment } satisfies Partial<WorkspaceEntry>)),
        ...(displayName === undefined ? {} : ({ displayName } satisfies Partial<WorkspaceEntry>)),
      }
      await request(store.put(renamed, workspaceId))
      return renamed
    })
  }

  /**
   * Whether `workspaceId` still holds a row in the per-document index older
   * builds wrote — a document that predates the workspace tree. Nothing this
   * build does writes one, so an answer of false stays false; a true one is
   * a workspace the browser keeper refuses rather than reads
   * (`BrowserStorageRefusedError`). A count, not a parse: any row there at
   * all is a document the tree does not hold.
   */
  async holdsPreTreeRecords(workspaceId: string): Promise<boolean> {
    return this.tx([DOCUMENT_INDEX_STORE], 'readonly', async (tx) => {
      const range = IDBKeyRange.bound([workspaceId], [workspaceId, []])
      return (await request(tx.objectStore(DOCUMENT_INDEX_STORE).count(range))) > 0
    })
  }

  /**
   * Whether the sync store still holds a per-document content record
   * (`document:<id>`) — the shape builds before the workspace tree kept a
   * document's content in. Nothing this build writes or reads is keyed that
   * way, so a true answer is a browser workspace it refuses
   * (`BrowserStorageRefusedError`) and the file sweep stands down over: the
   * sweep must not delete files a record it cannot read may still name.
   * Keys only, never a value. A `workspace-tree:` key with a non-canonical id
   * throws (`StoredWorkspaceKeyError`), a failure of the probe and no verdict.
   */
  async holdsPreTreeContentRecords(): Promise<boolean> {
    const keys = await this.tx([SYNC_DOCUMENTS_STORE], 'readonly', (tx) =>
      request(tx.objectStore(SYNC_DOCUMENTS_STORE).getAllKeys()),
    )
    return keys.some((key) => typeof key === 'string' && workspaceIdOfStoredDocKey(key) === null)
  }
}
