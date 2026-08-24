import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { openWhiteboardDb, SYNC_DOCUMENTS_STORE } from '../lib/browser-idb.js'
import { IdbDocumentStore } from '../lib/idb-document-store.js'

/**
 * Write a `DocumentStore` record straight into IndexedDB, bypassing the store.
 *
 * For the cases a test cannot reach through the API: bytes that are not Loro's,
 * a delta that will not import, an envelope from a version this build does not
 * know. `LoroStore` classifies each of those differently and the classification
 * is what these fixtures exist to pin — so the fixture has to be able to write
 * a record the store itself would refuse to produce.
 *
 * Pass `{ raw }` to write a value verbatim — an envelope from a version this
 * build does not know, or one that parses as nothing.
 */
export async function seedSyncDocument(
  documentId: string,
  content: { snapshot: Uint8Array; deltas?: Uint8Array[] } | { raw: unknown },
  dbName?: string,
): Promise<void> {
  // Only the `raw` path bypasses the store. A snapshot of arbitrary bytes is
  // a perfectly valid record — what makes it a fixture is that Loro cannot
  // import it, which is the store's caller's problem and not the store's — so
  // writing it through `IdbDocumentStore` keeps this helper from carrying its
  // own copy of a storage layout that has already changed once underneath it.
  if (!('raw' in content)) {
    const docRef = { kind: 'document', documentId } as const
    const store = new IdbDocumentStore(dbName)
    const { manifest, chunks } = chunkSnapshot(new Uint8Array(content.snapshot), 1_000_000)
    // Empty, matching what `LoroStore` writes: nothing in the browser reads a
    // frontier, and a fixture inventing one would be a value the first real
    // reader has to unpick.
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: new Uint8Array() })
    const deltas = content.deltas ?? []
    if (deltas.length > 0) {
      await store.appendDeltas({
        docRef,
        deltaBatch: {
          updates: deltas.map((delta) => new Uint8Array(delta)),
          newFrontier: new Uint8Array(),
        },
      })
    }
    return
  }

  const value = content.raw
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
