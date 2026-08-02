/**
 * Single opener for the shared 'whiteboard' IndexedDB, used by both
 * browser-local-store.ts (legacy JSON 'canvases' metadata) and loro-store.ts
 * (canonical 'loroCanvases' CRDT records). Both stores live in the same
 * database, so a version bump or upgrade change to one that isn't mirrored in
 * the other produces a VersionError the next time the stale opener runs.
 * Owning DB_VERSION and onupgradeneeded in one place makes that impossible by
 * construction instead of relying on a hand-synced comment.
 */
const DB_NAME = 'whiteboard'

/**
 * v2 -> v3: elements are canonical in the Loro doc ('loroCanvases'); the JSON
 * 'canvases' row is demoted to metadata only (id/name/updatedAt). Any legacy
 * 'scene' field left over from a pre-v3 row is stripped during upgrade so no
 * old-schema shape survives to fail canvasSnapshotSchema.parse.
 *
 * v3 -> v4: additive — adds the 'canvasFiles' object store (uploaded image
 * Blobs, see canvas-file-store.ts). Existing 'meta'/'canvases'/'loroCanvases'
 * data is untouched.
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
 * Known limitation (accepted, not handled): if another tab holds a
 * connection open at the previous version, this open blocks
 * (onblocked/onversionchange) until that tab closes or upgrades — the same
 * behavior every prior DB_VERSION bump in this file has had. No new handling
 * is added for it here.
 */
export const DB_VERSION = 6

function stripLegacySceneField(tx: IDBTransaction): void {
  const store = tx.objectStore('canvases')
  const cursorReq = store.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) return
    const value = cursor.value as unknown
    // Guard the `in` check: a corrupt/non-object row would otherwise throw a
    // TypeError, aborting the upgrade transaction and bricking the DB open.
    if (typeof value === 'object' && value !== null && 'scene' in value) {
      const { scene: _scene, ...metadataOnly } = value as Record<string, unknown>
      cursor.update(metadataOnly)
    }
    cursor.continue()
  }
}

export function openWhiteboardDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = req.result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
      if (!db.objectStoreNames.contains('canvasFiles')) db.createObjectStore('canvasFiles')
      // Guarded: deleteObjectStore on a store that does not exist throws and
      // aborts the whole upgrade transaction, which would brick the DB open
      // for a fresh install (oldVersion 0) or any DB that never reached v5.
      if (db.objectStoreNames.contains('reconnectKeypairs')) {
        db.deleteObjectStore('reconnectKeypairs')
      }

      // oldVersion === 0 is a fresh install (empty 'canvases' store), so the
      // scene-strip is a pure no-op there — only run it for a real v1/v2 upgrade.
      // req.transaction is always non-null inside onupgradeneeded; narrowed for TS.
      if (event.oldVersion > 0 && event.oldVersion < 3 && req.transaction) {
        stripLegacySceneField(req.transaction)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
