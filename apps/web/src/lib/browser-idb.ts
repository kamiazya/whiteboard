/**
 * Single opener for the shared 'whiteboard' IndexedDB, used by both
 * browser-local-store.ts (legacy JSON 'canvases' metadata) and loro-store.ts
 * (canonical 'loroCanvases' CRDT records). Both stores live in the same
 * database, so a version bump or upgrade change to one that isn't mirrored in
 * the other produces a VersionError the next time the stale opener runs.
 * Owning DB_VERSION and onupgradeneeded in one place makes that impossible by
 * construction instead of relying on a hand-synced comment.
 */
export const DB_NAME = 'whiteboard'

/**
 * v2 -> v3: elements are canonical in the Loro doc ('loroCanvases'); the JSON
 * 'canvases' row is demoted to metadata only (id/name/updatedAt). Any legacy
 * 'scene' field left over from a pre-v3 row is stripped during upgrade so no
 * old-schema shape survives to fail canvasSnapshotSchema.parse.
 */
export const DB_VERSION = 3

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
