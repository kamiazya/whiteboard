/**
 * Single opener for the shared 'whiteboard' IndexedDB, used by both
 * browser-local-store.ts (JSON 'documents' metadata) and loro-store.ts
 * (canonical 'loroDocuments' CRDT records). Both stores live in the same
 * database, so a version bump or upgrade change to one that isn't mirrored in
 * the other produces a VersionError the next time the stale opener runs.
 * Owning DB_VERSION and onupgradeneeded in one place makes that impossible by
 * construction instead of relying on a hand-synced comment.
 */
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
 * The database name is a parameter so a test can have one of its own. Browser
 * tests share an origin, so two FILES touching `whiteboard` interleave: a
 * suite that deletes the database between cases will do so while another file
 * is seeding a fixture into it, and the failure lands in the file that did
 * nothing wrong. Production has exactly one name and never passes this.
 */

/**
 * v2 -> v3: elements are canonical in the Loro doc; the JSON metadata row is
 * demoted to metadata only (id/name/updatedAt). Any legacy 'scene' field left
 * over from a pre-v3 row is stripped during upgrade so no old-schema shape
 * survives to fail documentSnapshotSchema.parse.
 *
 * v3 -> v4: additive — adds the uploaded-image Blob store (see
 * document-file-store.ts). Existing data is untouched.
 *
 * v4 -> v5: additive — added the 'reconnectKeypairs' object store (WebCrypto
 * ECDSA P-256 keypairs for silent-reconnect).
 *
 * v5 -> v6: REMOVES the 'reconnectKeypairs' object store. Unattended
 * reconnect is gone (see docs/explanation/security-model.md): a process
 * that takes over this origin's port inherits everything in this origin's
 * storage, and a non-extractable CryptoKey does not need to be exfiltrated
 * to be abused — same-origin script can call crypto.subtle.sign() with it
 * directly. Deleting the store (not just abandoning it) is the point: a
 * credential no longer read but still stored is still stealable. The
 * companion plaintext secret this store's credential redeemed
 * (localStorage['whiteboard.reconnect-secret.v1']) is purged separately by
 * purge-legacy-reconnect-credentials.ts, since a localStorage key is not
 * reachable from this IndexedDB upgrade transaction.
 *
 * v6 -> v7: renames the three stores that spelled the CONTAINER `canvas`,
 * which ADR-0009 calls a Document — 'canvases' -> 'documents',
 * 'loroCanvases' -> 'loroDocuments', 'canvasFiles' -> 'documentFiles' — plus
 * the 'meta' pointer key 'defaultCanvasId' -> 'defaultDocumentId'.
 * IndexedDB has no rename, so each store is created, copied record by record,
 * and the old one deleted once its cursor is exhausted. The pre-v3 'scene'
 * strip is folded into that copy rather than kept as a separate pass: it is a
 * guarded no-op on every v3+ row, and running it inside the copy avoids two
 * cursors contending over the same source store.
 *
 * v7 -> v8: DISCARDS every document row that predates workspace+path
 * addressing. A pre-v8 row carries only `{id, name, updatedAt, kind}` — no
 * workspace, no path, and a `crypto.randomUUID()` id the model's canonical
 * ULID schema refuses — so there is nothing to migrate it TO without
 * inventing an address, and an invented address is worse than none: it is
 * indistinguishable from one the user chose. Local documents are discardable
 * by explicit decision (0.0.x, no users), so the row and its Loro record are
 * deleted outright, and the default pointer is cleared when it named one of
 * them. Deleting the bytes matters as much as the row: a Loro record no
 * document names is unreachable storage nothing would ever collect.
 *
 * v8 -> v9: adds the two stores behind the browser's `DocumentIndex` port
 * implementation — `workspaces` (keyed by workspaceId) and `documentIndex`
 * (keyed by the pair `[workspaceId, path]`, with a unique `byId` index on
 * `[workspaceId, documentId]`). Purely additive; the bespoke `documents`
 * store keeps serving `browser-local-store.ts` until its call sites move.
 *
 * The compound keys are the schema doing the work rather than the code: the
 * primary key IS the uniqueness rule `createDocument` has to enforce, so
 * claiming a path is one `add()` that fails on conflict rather than a read
 * followed by a write two callers could interleave.
 *
 * v9 -> v10: backfills those two stores from the bespoke `documents` store
 * and then drops it. v9 created them empty on the promise that `documents`
 * would keep serving reads "until its call sites move"; this is that move.
 * The row shapes already agree — v8 left every surviving row carrying a
 * `workspaceId` and a `path` — so the backfill is a copy, not a conversion.
 * The `workspaces` row is written even when there is nothing to copy: the
 * port answers a list against an unknown workspace with an error rather than
 * an empty list, so a user who had no documents must still get a workspace or
 * their first visit reads as a failure.
 *
 * v10 -> v11: adds `blobs`, the `BlobStore` port's store — content-addressed
 * bytes keyed by `<algorithm>:<digestHex>`. Purely additive, and nothing is
 * migrated INTO it: `documentFiles` keeps its own records and gains a
 * fileId -> ref mapping beside them, because the fileId a document embeds is
 * a published address (the daemon's file route validates it) and is not this
 * increment's to change.
 *
 * v11 -> v12: adds `syncDocuments`, the `DocumentStore` port's store. One
 * record per `docRefKey`, holding the snapshot manifest, its chunk bytes, the
 * frontier and the delta log together — the daemon spreads the same state
 * across four SQL tables because a row is the unit there, and a record is the
 * unit here, so one `readwrite` transaction over one key gives the port's
 * atomicity without a join.
 *
 * Purely additive, and deliberately NOT where `LoroStore` writes: that store
 * keeps `loroDocuments` until its callers move, and two writers on one shape
 * during a transition is how a subtle corruption gets in.
 *
 * Cross-tab upgrades are handled rather than accepted from v8 on: every
 * connection this module opens closes itself on `versionchange`, so a newer
 * tab's upgrade is not blocked by an older one sitting idle, and a block that
 * happens anyway (a tab still running a pre-v8 bundle) rejects with a
 * message a caller can show instead of hanging on a request that never
 * settles.
 */
export const DB_VERSION = 12

/** The `DocumentIndex` port's two stores. Exported so the implementation and
 * the opener cannot disagree about a name. */
export const WORKSPACES_STORE = 'workspaces'
export const DOCUMENT_INDEX_STORE = 'documentIndex'

/** The `BlobStore` port's store. Keyed by `<algorithm>:<digestHex>` — the ref
 * IS the key, which is what makes the store deduplicating by construction. */
export const BLOBS_STORE = 'blobs'

/** Where a document's file references live: fileId -> BlobRef. */
export const DOCUMENT_FILES_STORE = 'documentFiles'

/** The `DocumentStore` port's store, keyed by `docRefKey`. */
export const SYNC_DOCUMENTS_STORE = 'syncDocuments'

const RENAMED_STORES: readonly (readonly [from: string, to: string])[] = [
  ['canvases', 'documents'],
  ['loroCanvases', 'loroDocuments'],
  ['canvasFiles', 'documentFiles'],
]

/**
 * Copies every record of `from` into `to`, then deletes `from`.
 *
 * The delete is deferred to the cursor's terminal callback on purpose:
 * `deleteObjectStore` is legal at any point in a versionchange transaction,
 * but calling it while the copy's cursor is still walking would kill the
 * source out from under the requests that have not run yet.
 */
function copyStoreThenDelete(
  db: IDBDatabase,
  tx: IDBTransaction,
  from: string,
  to: string,
  onDone: () => void,
): void {
  if (!db.objectStoreNames.contains(from)) {
    onDone()
    return
  }
  const source = tx.objectStore(from)
  const target = tx.objectStore(to)
  const cursorReq = source.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      db.deleteObjectStore(from)
      onDone()
      return
    }
    target.put(stripLegacySceneField(cursor.value), cursor.key)
    cursor.continue()
  }
}

/**
 * Drops the pre-v3 `scene` field a metadata row must not carry. Guarded
 * against a non-object row: a corrupt value would otherwise throw a TypeError
 * out of the `in` check, aborting the upgrade transaction and bricking the DB
 * open.
 */
function stripLegacySceneField(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('scene' in value)) return value
  const { scene: _scene, ...metadataOnly } = value as Record<string, unknown>
  return metadataOnly
}

/**
 * True for a row already addressed the way v8 stores one.
 *
 * Written out rather than delegating to `documentSnapshotSchema`: a migration
 * has to keep meaning what it meant on the day it ran, and a live schema is
 * free to gain a required field later, which would silently turn this into a
 * discard of rows it was never meant to touch. Guarded against a non-object
 * value — a corrupt row must not throw out of an upgrade transaction, which
 * would abort it and brick the database open.
 */
function isPathAddressed(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.documentId === 'string' &&
    typeof row.workspaceId === 'string' &&
    typeof row.path === 'string'
  )
}

function discardPrePathDocuments(tx: IDBTransaction, done: () => void): void {
  const documents = tx.objectStore('documents')
  const loro = tx.objectStore('loroDocuments')
  const meta = tx.objectStore('meta')
  const cursorReq = documents.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      done()
      return
    }
    if (!isPathAddressed(cursor.value)) {
      const key = cursor.primaryKey
      cursor.delete()
      loro.delete(key)
      // Cleared only when it named THIS row: a blanket clear would log a user
      // out of the documents that survive.
      const pointer = meta.get('defaultDocumentId')
      pointer.onsuccess = () => {
        if (pointer.result === key) meta.delete('defaultDocumentId')
      }
    }
    cursor.continue()
  }
}

/**
 * Copies every surviving `documents` row into the `DocumentIndex` stores, then
 * drops `documents`.
 *
 * The workspace rows come from the documents themselves rather than from a
 * hardcoded `'local'`: this store never held more than one workspace, but
 * reading it from the data is the version that stays correct if it ever did.
 * `LOCAL_WORKSPACE_ID` is still written unconditionally, because that is the
 * one the browser-local UI opens.
 */
function backfillDocumentIndex(tx: IDBTransaction): void {
  const documents = tx.objectStore('documents')
  const workspaces = tx.objectStore(WORKSPACES_STORE)
  const index = tx.objectStore(DOCUMENT_INDEX_STORE)
  workspaces.put({ workspaceId: 'local' }, 'local')
  const cursorReq = documents.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      // Only once the walk is done: deleting the store mid-cursor would end
      // the walk with rows still uncopied.
      tx.db.deleteObjectStore('documents')
      return
    }
    const row = cursor.value
    if (isPathAddressed(row)) {
      const { workspaceId, documentId, path, kind, name } = row
      workspaces.put({ workspaceId }, workspaceId)
      index.put({
        workspaceId,
        documentId,
        path,
        kind,
        ...(name === undefined || name === path ? {} : { name }),
      })
    }
    cursor.continue()
  }
}

function renameMetaKey(tx: IDBTransaction, from: string, to: string): void {
  const meta = tx.objectStore('meta')
  const req = meta.get(from)
  req.onsuccess = () => {
    if (req.result === undefined) return
    meta.put(req.result, to)
    meta.delete(from)
  }
}

export function openWhiteboardDb(dbName: string = activeDbName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      for (const [, to] of RENAMED_STORES) {
        if (!db.objectStoreNames.contains(to)) db.createObjectStore(to)
      }
      // Guarded: deleteObjectStore on a store that does not exist throws and
      // aborts the whole upgrade transaction, which would brick the DB open
      // for a fresh install (oldVersion 0) or any DB that never reached v5.
      if (db.objectStoreNames.contains('reconnectKeypairs')) {
        db.deleteObjectStore('reconnectKeypairs')
      }
      if (!db.objectStoreNames.contains(WORKSPACES_STORE)) db.createObjectStore(WORKSPACES_STORE)
      if (!db.objectStoreNames.contains(BLOBS_STORE)) db.createObjectStore(BLOBS_STORE)
      if (!db.objectStoreNames.contains(SYNC_DOCUMENTS_STORE)) {
        db.createObjectStore(SYNC_DOCUMENTS_STORE)
      }
      if (!db.objectStoreNames.contains(DOCUMENT_INDEX_STORE)) {
        const index = db.createObjectStore(DOCUMENT_INDEX_STORE, {
          keyPath: ['workspaceId', 'path'],
        })
        index.createIndex('byId', ['workspaceId', 'documentId'], { unique: true })
      }

      // req.transaction is always non-null inside onupgradeneeded; narrowed for TS.
      const tx = req.transaction
      if (!tx) return
      renameMetaKey(tx, 'defaultCanvasId', 'defaultDocumentId')
      // The discard runs only once every rename copy has drained, because it
      // walks the store those copies are still filling. Calling it beside them
      // is NOT equivalent: a cursor opened while the copy's puts are still
      // queued in their own callbacks sees an empty store, deletes nothing,
      // and looks exactly like a successful upgrade. Measured — a v6 pre-path
      // row survived a v6->v8 open until this was ordered.
      let pendingCopies = RENAMED_STORES.length
      const onCopyDone = () => {
        pendingCopies -= 1
        if (pendingCopies === 0) {
          // Ordered, for the same reason the discard is: the backfill walks
          // `documents`, which the rename copies are still filling, and the
          // discard decides which of those rows are worth carrying. Reading
          // before either drains sees an empty store and silently indexes
          // nothing.
          discardPrePathDocuments(tx, () => backfillDocumentIndex(tx))
        }
      }
      for (const [from, to] of RENAMED_STORES) copyStoreThenDelete(db, tx, from, to, onCopyDone)
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
    req.onerror = () => reject(req.error)
  })
}
