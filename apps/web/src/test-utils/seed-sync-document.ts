import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { openWhiteboardDb, SYNC_DOCUMENTS_STORE } from '../lib/browser-idb.js'

/**
 * Write a `DocumentStore` record straight into IndexedDB, bypassing the store.
 *
 * For the cases a test cannot reach through the API: bytes that are not Loro's,
 * a delta that will not import, an envelope from a version this build does not
 * know. `LoroStore` classifies each of those differently and the classification
 * is what these fixtures exist to pin — so the fixture has to be able to write
 * a record the store itself would refuse to produce.
 *
 * `record: null` writes the envelope raw, for the unknown-version case.
 */
export async function seedSyncDocument(
  documentId: string,
  content: { snapshot: Uint8Array; deltas?: Uint8Array[] } | { raw: unknown },
  dbName?: string,
): Promise<void> {
  const value =
    'raw' in content
      ? content.raw
      : {
          v: 1,
          snapshot: (() => {
            const { manifest, chunks } = chunkSnapshot(new Uint8Array(content.snapshot), 1_000_000)
            return { manifest, chunks }
          })(),
          frontier: new Uint8Array(),
          deltas: (content.deltas ?? []).map((delta) => new Uint8Array(delta)),
        }
  const db = await openWhiteboardDb(dbName)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SYNC_DOCUMENTS_STORE, 'readwrite')
      tx.objectStore(SYNC_DOCUMENTS_STORE).put(value, `document:${documentId}`)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
    })
  } finally {
    db.close()
  }
}
