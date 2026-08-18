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
 * Known limitation (accepted, not handled): if another tab holds a
 * connection open at the previous version, this open blocks
 * (onblocked/onversionchange) until that tab closes or upgrades — the same
 * behavior every prior DB_VERSION bump in this file has had. No new handling
 * is added for it here.
 */
export const DB_VERSION = 7

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
function copyStoreThenDelete(db: IDBDatabase, tx: IDBTransaction, from: string, to: string): void {
  if (!db.objectStoreNames.contains(from)) return
  const source = tx.objectStore(from)
  const target = tx.objectStore(to)
  const cursorReq = source.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      db.deleteObjectStore(from)
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

function renameMetaKey(tx: IDBTransaction, from: string, to: string): void {
  const meta = tx.objectStore('meta')
  const req = meta.get(from)
  req.onsuccess = () => {
    if (req.result === undefined) return
    meta.put(req.result, to)
    meta.delete(from)
  }
}

export function openWhiteboardDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
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

      // req.transaction is always non-null inside onupgradeneeded; narrowed for TS.
      const tx = req.transaction
      if (!tx) return
      for (const [from, to] of RENAMED_STORES) copyStoreThenDelete(db, tx, from, to)
      renameMetaKey(tx, 'defaultCanvasId', 'defaultDocumentId')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
