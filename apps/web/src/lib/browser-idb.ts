/**
 * Single opener for the shared 'whiteboard' IndexedDB. Every store lives in
 * this one database, so the version and the schema are owned here, in one
 * place, rather than by each store that opens it.
 *
 * ONE baseline schema, created whole on a fresh install. There is no upgrade
 * ladder: a database at an older version than this one is not migrated but
 * REFUSED (`BrowserStorageRefusedError`, reason `database-version`), and is
 * left exactly as it was — the open is aborted before anything is written,
 * so no byte the person had is touched. Old stored shapes are not carried
 * forward (0.0.x, no compatibility), and refusing by name is what keeps that
 * from reading as an empty browser. A daemon-kept workspace never opens this
 * database, so it is unaffected.
 */
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { BrowserStorageRefusedError } from './browser-storage-refusal.js'

/** The `DocumentIndex` port's two stores. Exported so the implementation and
 * the opener cannot disagree about a name. */
export const WORKSPACES_STORE = 'workspaces'
export const DOCUMENT_INDEX_STORE = 'documentIndex'

/** The `BlobStore` port's store. Keyed by `<algorithm>:<digestHex>` — the ref
 * IS the key, which is what makes the store deduplicating by construction. */
export const BLOBS_STORE = 'blobs'

/** Where a document's file references live: fileId -> BlobRef. */
export const DOCUMENT_FILES_STORE = 'documentFiles'

/** The `DocumentStore` port's store, keyed by `docRefKey`. Holds a document's
 * snapshot MANIFEST, frontier and delta log — never the snapshot's bytes. */
export const SYNC_DOCUMENTS_STORE = 'syncDocuments'

/**
 * The snapshot bytes those manifests describe, keyed by `[docRefKey, index]`.
 *
 * A separate store rather than a separate field, because the cost this splits
 * is IndexedDB's `get`: a record comes back whole or not at all, so any read of
 * a document's delta log paid for its snapshot too. A compound key gives each
 * chunk its own value while keeping a document's chunks contiguous, so
 * replacing or deleting a snapshot is one ranged operation.
 */
export const SYNC_SNAPSHOT_CHUNKS_STORE = 'syncSnapshotChunks'

/**
 * When a document's content was last written, keyed by documentId.
 *
 * Its own store because it belongs to neither port. `DocumentStore` has no
 * notion of wall-clock time — a frontier is the only ordering it knows — and
 * `DocumentIndex` deliberately holds only placement and naming. This is the
 * third app-side concern beside the default-document pointer and the content
 * clock that reads it, and it lives where those do: outside the contracts.
 */
export const CONTENT_TIMESTAMPS_STORE = 'contentTimestamps'

/**
 * A document's saved versions, keyed by version id, with a `byDocument`
 * index over `[workspaceId, documentId]`.
 *
 * A version is a FRONTIER into the workspace record (the same shape the
 * daemon's `versions` table keeps) plus the row the History panel lists —
 * never a copy of the content. The record keeps every op it ever held (the
 * fold re-snapshots, it does not shallow-export), so a frontier saved today
 * still checks out after any number of folds.
 */
export const VERSIONS_STORE = 'versions'
export const VERSIONS_BY_DOCUMENT_INDEX = 'byDocument'

/**
 * The name the browser's own workspace answers to in a URL.
 *
 * A fixed word rather than something derived, because there is nothing to
 * derive from: this is the one workspace nobody chose to create. `default`
 * asserts only what is true — the workspace you get without choosing one —
 * where `personal` or `home` would assert a use the app cannot know.
 * ADR-0019 makes a segment renameable, so a word its owner dislikes costs
 * exactly one rename.
 */
export const BROWSER_DEFAULT_SEGMENT = 'default'

/** A store the baseline holds: its name, the options it is created with, and its indexes. */
type StoreSpec = {
  readonly name: string
  readonly options?: IDBObjectStoreParameters
  readonly indexes?: readonly {
    readonly name: string
    readonly keyPath: string | readonly string[]
    readonly options?: IDBIndexParameters
  }[]
}

/**
 * Every store the database holds. `documentIndex` keeps the per-document rows
 * builds before the workspace tree wrote: nothing writes it now, and a row in
 * it is a workspace the browser keeper refuses (`holdsPreTreeRecords`).
 */
const BASELINE_STORES: readonly StoreSpec[] = [
  { name: 'meta' },
  { name: WORKSPACES_STORE },
  { name: BLOBS_STORE },
  { name: DOCUMENT_FILES_STORE },
  { name: SYNC_DOCUMENTS_STORE },
  { name: SYNC_SNAPSHOT_CHUNKS_STORE },
  { name: CONTENT_TIMESTAMPS_STORE },
  {
    name: DOCUMENT_INDEX_STORE,
    options: { keyPath: ['workspaceId', 'path'] },
    indexes: [{ name: 'byId', keyPath: ['workspaceId', 'documentId'], options: { unique: true } }],
  },
  {
    name: VERSIONS_STORE,
    options: { keyPath: 'id' },
    indexes: [{ name: VERSIONS_BY_DOCUMENT_INDEX, keyPath: ['workspaceId', 'documentId'] }],
  },
]

const DB_NAME = 'whiteboard'

// The name every opener below resolves when its caller passes none. Module
// state, not a parameter, because page-level browser tests mount whole pages
// that construct their stores internally — no argument can reach them.
// Browser test files each run in their own page with their own module graph,
// so setting this in one file cannot leak into another; what IS shared across
// files is the origin's IndexedDB itself, which is exactly why every file
// must claim its own name instead of deleting the shared one out from under
// its neighbours.
let activeDbName = DB_NAME

/**
 * Point this page's openers at a private database. Test seam, same shape as
 * `openWhiteboardDb(dbName?)`: production never calls it. See
 * `test-utils/isolated-whiteboard-db.ts` for the helper tests actually use.
 */
export function setWhiteboardDbNameForTests(name: string): void {
  activeDbName = name
}

/** The database name this page's openers currently resolve. */
export function whiteboardDbName(): string {
  return activeDbName
}

/**
 * The one schema version. It stays at the number the last upgrade step
 * reached, so a database that step left behind opens as the baseline it is;
 * every lower number is a database this build refuses.
 */
export const DB_VERSION = 20

/**
 * Creates the baseline on a fresh install: every store, and the browser's own
 * workspace — the one nobody chose to create — under a canonical id and the
 * `default` segment, so a first visit has a workspace to list.
 */
function createBaseline(db: IDBDatabase, tx: IDBTransaction): void {
  for (const spec of BASELINE_STORES) {
    const store = db.createObjectStore(spec.name, spec.options)
    for (const index of spec.indexes ?? []) {
      store.createIndex(index.name, index.keyPath as string | string[], index.options)
    }
  }
  const workspaceId = generateDocumentId()
  tx.objectStore(WORKSPACES_STORE).put(
    { workspaceId, segment: BROWSER_DEFAULT_SEGMENT },
    workspaceId,
  )
}

/**
 * The database name is a parameter so a test can have one of its own. Browser
 * tests share an origin, so two FILES touching `whiteboard` interleave: a
 * suite that deletes the database between cases will do so while another file
 * is seeding a fixture into it, and the failure lands in the file that did
 * nothing wrong. Production has exactly one name and never passes this.
 */
export function openWhiteboardDb(dbName: string = activeDbName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION)
    let refusedFrom: number | null = null
    req.onupgradeneeded = (event) => {
      // req.transaction is always non-null inside onupgradeneeded; narrowed for TS.
      const tx = req.transaction
      if (!tx) return
      if (event.oldVersion === 0) {
        createBaseline(req.result, tx)
        return
      }
      // Aborted, not upgraded: the abort rolls the version change back, so
      // the database stays at its old version with every record it held.
      refusedFrom = event.oldVersion
      tx.abort()
    }
    req.onsuccess = () => {
      const db = req.result
      // Without this, an idle tab holding an older version blocks every newer
      // tab's upgrade until someone closes it — the connection has no reason
      // to outlive the schema it was opened against.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    // The request is not aborted by this rejection: if the blocking tab later
    // closes, `onsuccess` still runs and opens a connection nobody holds. That
    // is deliberately left alone rather than closed — the `onversionchange`
    // handler above is set on it too, so it steps aside for the next upgrade
    // or delete, which is the only harm an unowned connection can do here.
    req.onblocked = () =>
      reject(new Error('another tab has this app open at an older version; close it and reload'))
    req.onerror = () => {
      if (refusedFrom === null) {
        reject(req.error)
        return
      }
      reject(
        new BrowserStorageRefusedError(
          'database-version',
          `database version ${refusedFrom}, baseline ${DB_VERSION}`,
        ),
      )
    }
  })
}
