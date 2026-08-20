import type { DocumentEntry, DocumentIndex } from '@kamiazya/whiteboard-ports'
import { openWhiteboardDb } from './browser-idb.js'
import { loroRecordEnvelopeSchema } from './loro-record-envelope.js'
import type { DocumentSnapshot } from './whiteboard-client.js'

/**
 * The one workspace browser-local mode has. Stored on every row rather than
 * implied, so a local document carries the same address a daemon one does.
 */
export const LOCAL_WORKSPACE_ID = 'local'

/**
 * What `DocumentIndex` deliberately does not own, for browser-local mode.
 *
 * The port answers placement, identity, kind and name. Two things a user still
 * needs are not in it, and are not gaps in it:
 *
 * - **which document a plain load resumes into.** A pointer, not a property of
 *   any document — the daemon has no equivalent because a URL always names one.
 * - **when a document was last edited.** The port's `DocumentEntry` carries no
 *   timestamp, and the daemon's own listing gets one from its store rather than
 *   its index. This is the browser's counterpart of that.
 *
 * Both are apps/web product concerns, so they live beside the port rather than
 * bending the contract around them.
 */

/** Read only the envelope's timestamp field for each id, in one transaction. */
async function contentUpdatedAt(db: IDBDatabase, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('loroDocuments', 'readonly')
    const store = tx.objectStore('loroDocuments')
    const stamps = new Map<string, string>()
    for (const id of ids) {
      const req = store.get(id)
      req.onsuccess = () => {
        // The ENVELOPE only. `LoroStore.load` goes further and imports the
        // bytes to reject a structurally-valid record whose CRDT payload is
        // corrupt — deliberately not repeated here, because doing it would
        // import every listed document's snapshot on every list AND put
        // `loro-crdt` back on the critical path (measured at +24.3 KB gzip,
        // which is why the schema has its own module).
        //
        // The consequence, stated rather than hidden: a corrupt record still
        // contributes the timestamp its writer stamped, so a document whose
        // content will not load can still read as recently edited. That is a
        // last-write time, which is what this field claims to be; whether the
        // bytes are readable is a question for whoever loads them.
        const parsed = loroRecordEnvelopeSchema.safeParse(req.result)
        if (parsed.success) stamps.set(id, parsed.data.updatedAt)
      }
    }
    tx.oncomplete = () => resolve(stamps)
    tx.onerror = () => reject(tx.error)
    // Without onabort an aborted transaction leaves this promise pending and
    // the caller awaits it — a hang rather than a failure. A connection
    // closing abnormally aborts its active transactions, so this is reachable
    // without anyone calling abort() directly.
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
  })
}

/**
 * A listing row: the index entry plus its content timestamp.
 *
 * `name` falls back to the path here rather than in the port. `DocumentEntry`
 * leaves it ABSENT when a document has none, precisely so a reader chooses;
 * a listing that invents one reads as though somebody typed the path in as a
 * title. Choosing is this layer's job.
 *
 * A document with no content record reports the epoch rather than being
 * dropped: every create path seeds one, so it should not happen, but hiding a
 * stored row is the dishonest failure, and the epoch sorts it last instead of
 * first.
 */
function toSnapshot(entry: DocumentEntry, updatedAt: string | undefined): DocumentSnapshot {
  return {
    documentId: entry.documentId,
    workspaceId: LOCAL_WORKSPACE_ID,
    path: entry.path,
    name: entry.name ?? entry.path,
    updatedAt: updatedAt ?? new Date(0).toISOString(),
    kind: entry.kind ?? 'spatial',
  }
}

/**
 * Where a document's last-write time comes from. Injected because the default
 * reads IndexedDB, and the jsdom test project has none — a page test wants the
 * projection, not the storage. A test that does not care supplies
 * `async () => new Map()`, and every document then reports the epoch — which
 * is what a document with no content record reports anyway.
 */
export type ContentClock = (ids: string[]) => Promise<Map<string, string>>

export function idbContentClock(dbName?: string): ContentClock {
  return async (ids) => {
    if (ids.length === 0) return new Map()
    const db = await openWhiteboardDb(dbName)
    try {
      return await contentUpdatedAt(db, ids)
    } finally {
      db.close()
    }
  }
}

/**
 * Creates the browser-local workspace if this device has never had one.
 *
 * The port distinguishes an absent workspace from an empty one — a list
 * against an unknown id is a `WorkspaceNotFoundError`, not `[]` — and nothing
 * on the browser side owns "first run". So every path that would be the first
 * to touch the index calls this first. It is a `put`, so calling it on every
 * create costs one no-op write and removes the need for anyone to know
 * whether they are first.
 */
export async function ensureLocalWorkspace(index: DocumentIndex): Promise<void> {
  await index.createWorkspace({ workspaceId: LOCAL_WORKSPACE_ID })
}

export async function listLocalDocuments(
  index: DocumentIndex,
  clock: ContentClock = idbContentClock(),
): Promise<DocumentSnapshot[]> {
  const entries = await index.listDocuments({ workspaceId: LOCAL_WORKSPACE_ID })
  if (entries.length === 0) return []
  const stamps = await clock(entries.map((entry) => entry.documentId))
  return entries.map((entry) => toSnapshot(entry, stamps.get(entry.documentId)))
}

/** The same projection for one document, or null when the index has no such id. */
export async function loadLocalDocument(
  index: DocumentIndex,
  documentId: string,
  clock: ContentClock = idbContentClock(),
): Promise<DocumentSnapshot | null> {
  const entry = await index.resolveDocumentById({ workspaceId: LOCAL_WORKSPACE_ID, documentId })
  if (entry === null) return null
  const stamps = await clock([documentId])
  return toSnapshot(entry, stamps.get(documentId))
}

const DEFAULT_POINTER_KEY = 'defaultDocumentId'

/**
 * Which document a plain load resumes into.
 *
 * An interface rather than two module functions for the same reason the clock
 * above is injected: the real one is IndexedDB, and a jsdom page test has
 * none. It is also the shape the controller already expects of its
 * dependencies — it takes its index and its Loro store the same way.
 */
export interface DefaultDocumentPointer {
  get(): Promise<string | null>
  set(documentId: string): Promise<void>
  clear(): Promise<void>
}

function metaTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', mode)
    const req = body(tx.objectStore('meta'))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    tx.onerror = () => reject(tx.error)
    // An abort with no handler leaves this promise pending forever, which
    // reads as a hang in whatever awaited it rather than as a failed write.
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
  })
}

export class IdbDefaultDocumentPointer implements DefaultDocumentPointer {
  constructor(private readonly dbName?: string) {}

  private async withDb<T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await openWhiteboardDb(this.dbName)
    try {
      return await metaTransaction(db, mode, body)
    } finally {
      db.close()
    }
  }

  async get(): Promise<string | null> {
    const value = await this.withDb('readonly', (store) => store.get(DEFAULT_POINTER_KEY))
    return (value as string | undefined) ?? null
  }

  async set(documentId: string): Promise<void> {
    await this.withDb('readwrite', (store) => store.put(documentId, DEFAULT_POINTER_KEY))
  }

  async clear(): Promise<void> {
    await this.withDb('readwrite', (store) => store.delete(DEFAULT_POINTER_KEY))
  }
}

/** The pointer a test gets when it is testing a page, not persistence. */
export class InMemoryDefaultDocumentPointer implements DefaultDocumentPointer {
  private documentId: string | null = null

  async get(): Promise<string | null> {
    return this.documentId
  }

  async set(documentId: string): Promise<void> {
    this.documentId = documentId
  }

  async clear(): Promise<void> {
    this.documentId = null
  }
}
