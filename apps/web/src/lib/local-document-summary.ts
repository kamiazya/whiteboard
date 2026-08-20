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

export async function listLocalDocuments(
  index: DocumentIndex,
  dbName?: string,
): Promise<DocumentSnapshot[]> {
  const entries = await index.listDocuments({ workspaceId: LOCAL_WORKSPACE_ID })
  if (entries.length === 0) return []
  const db = await openWhiteboardDb(dbName)
  try {
    const stamps = await contentUpdatedAt(
      db,
      entries.map((entry) => entry.documentId),
    )
    return entries.map((entry) => toSnapshot(entry, stamps.get(entry.documentId)))
  } finally {
    db.close()
  }
}

/** The same projection for one document, or null when the index has no such id. */
export async function loadLocalDocument(
  index: DocumentIndex,
  documentId: string,
  dbName?: string,
): Promise<DocumentSnapshot | null> {
  const entry = await index.resolveDocumentById({ workspaceId: LOCAL_WORKSPACE_ID, documentId })
  if (entry === null) return null
  const db = await openWhiteboardDb(dbName)
  try {
    const stamps = await contentUpdatedAt(db, [documentId])
    return toSnapshot(entry, stamps.get(documentId))
  } finally {
    db.close()
  }
}

const DEFAULT_POINTER_KEY = 'defaultDocumentId'

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

export async function getDefaultDocumentId(dbName?: string): Promise<string | null> {
  const db = await openWhiteboardDb(dbName)
  try {
    const value = await metaTransaction(db, 'readonly', (store) => store.get(DEFAULT_POINTER_KEY))
    return (value as string | undefined) ?? null
  } finally {
    db.close()
  }
}

export async function setDefaultDocumentId(documentId: string, dbName?: string): Promise<void> {
  const db = await openWhiteboardDb(dbName)
  try {
    await metaTransaction(db, 'readwrite', (store) => store.put(documentId, DEFAULT_POINTER_KEY))
  } finally {
    db.close()
  }
}

export async function clearDefaultDocumentId(dbName?: string): Promise<void> {
  const db = await openWhiteboardDb(dbName)
  try {
    await metaTransaction(db, 'readwrite', (store) => store.delete(DEFAULT_POINTER_KEY))
  } finally {
    db.close()
  }
}
