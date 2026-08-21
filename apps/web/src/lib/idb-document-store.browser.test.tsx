/**
 * The browser `DocumentStore`, held to the port's own conformance suite — the
 * same one the daemon's libSQL and in-memory stores pass, so a document's sync
 * state means one thing across all three.
 *
 * Nothing is asserted here beyond the contract. What this file adds is the
 * IndexedDB-specific fixture: a real database per case, deleted afterwards,
 * because every conformance case assumes a store that starts empty.
 */
import { describeDocumentStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe } from 'vitest'
import { IdbDocumentStore } from './idb-document-store.js'

// Its OWN database, not the app's — browser tests share an origin, so deleting
// `whiteboard` between cases would tear it out from under whatever other file
// is mid-fixture, and the failure would land there.
const DB_NAME = 'whiteboard-document-store-conformance'

async function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    // No `onblocked` resolve: `blocked` means the delete has NOT happened yet,
    // so resolving there starts the next case against the previous one's rows.
    // `IdbDocumentStore` closes its connection in a `finally`, so nothing this
    // suite opens outlives its own call.
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

describe('IdbDocumentStore', () => {
  describeDocumentStoreConformance(async () => {
    await deleteDb()
    return {
      store: new IdbDocumentStore(DB_NAME),
      dispose: deleteDb,
    }
  })
})
