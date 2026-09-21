/**
 * The names of the object stores the shared `whiteboard` database holds.
 *
 * Their own module because BOTH the opener and the upgrade steps name them,
 * and the two cannot import each other: the opener calls the steps, so a
 * store constant living beside either would close a cycle. Nothing here
 * imports anything, which is what keeps that true as the set grows.
 *
 * `browser-idb.ts` re-exports these, so a caller still reaches them at the
 * module it already imports.
 */

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
 * still checks out after any number of folds. v16 adds this store.
 */
export const VERSIONS_STORE = 'versions'
export const VERSIONS_BY_DOCUMENT_INDEX = 'byDocument'

/**
 * The picture a saved point carries, keyed by version id. v17 adds this store.
 *
 * RETIRED at v18, and named only so the upgrade can delete it. The history
 * row's miniature is gone — a saved point is looked at by opening it, which
 * draws the document itself in the reader's own theme, where the stored PNG
 * was baked light at save time and could never be anything else.
 *
 * The `hasThumbnail` boolean it left on existing version ROWS is gone at v19,
 * and not by the cursor rewrite this note refused. That refusal still stands:
 * `versionRowSchema` is `.strict()` and its reader SKIPS a row that fails to
 * parse, so a walk mis-ordered against the upgrade chain deletes a reader's
 * bookmarked history without failing loudly. v19 empties the store outright
 * for its own reason, so every row carrying the flag went with it and the
 * field left the schema without any row ever being rewritten.
 */
export const RETIRED_VERSION_THUMBNAILS_STORE = 'versionThumbnails'

/**
 * A store this database holds, as data: its name, the options it is created
 * with, and the indexes that belong to it.
 *
 * The opener used to spell each one as its own `if (!contains(name)) create`,
 * eleven of them in a row. The guard was repeated eleven times and the schema
 * was not readable anywhere — you recovered it by reading control flow. As a
 * list it is a declaration, the guard lives once in the loop that applies it,
 * and a new store is an entry rather than another branch.
 */
export type StoreSpec = {
  readonly name: string
  readonly options?: IDBObjectStoreParameters
  readonly indexes?: readonly {
    readonly name: string
    readonly keyPath: string | readonly string[]
    readonly options?: IDBIndexParameters
  }[]
}

/**
 * Every store the database holds at the current version, created on any open
 * that does not already have it.
 *
 * Creation is unconditional-per-name on purpose: an upgrade from ANY older
 * version reaches this list, so a store added at v16 is created for a v3
 * database and for a fresh install alike, without either naming a version.
 * The rename TARGETS are not here — they come from `RENAMED_STORES`, which
 * already carries them as data.
 */
export const CREATED_STORES: readonly StoreSpec[] = [
  { name: 'meta' },
  { name: WORKSPACES_STORE },
  { name: BLOBS_STORE },
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

/**
 * Stores a past version created and this one must not keep. Deleted on any
 * open that still has them.
 *
 * `reconnectKeypairs` (dropped at v6) held WebCrypto keypairs for unattended
 * reconnect; a credential no longer read but still stored is still stealable,
 * so it is deleted rather than abandoned. `versionThumbnails` (v18) held a
 * baked-light PNG per saved point.
 */
export const DELETED_STORES: readonly string[] = [
  'reconnectKeypairs',
  RETIRED_VERSION_THUMBNAILS_STORE,
]

/** Create `spec` and its indexes if this database does not have it yet. */
export function ensureStore(db: IDBDatabase, spec: StoreSpec): void {
  if (db.objectStoreNames.contains(spec.name)) return
  const store = db.createObjectStore(spec.name, spec.options)
  for (const index of spec.indexes ?? []) {
    store.createIndex(index.name, index.keyPath as string | string[], index.options)
  }
}

/**
 * Delete `name` if this database has it.
 *
 * The guard is the point: `deleteObjectStore` on a store that does not exist
 * THROWS and aborts the whole upgrade transaction, which would brick the open
 * for a fresh install (oldVersion 0) or for any database that never reached
 * the version that created it.
 */
export function dropStore(db: IDBDatabase, name: string): void {
  if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
}
