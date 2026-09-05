/**
 * The browser `BlobStore`, held to the port's own conformance suite — the
 * same one the daemon's filesystem and in-memory stores pass, so "content
 * addressed" cannot mean three different things in three places.
 *
 * Nothing is asserted here beyond the contract. What this file adds is the
 * IndexedDB-specific fixture: a real database per case, deleted afterwards,
 * because every conformance case assumes a store that starts empty.
 */
import { describeBlobStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import { IdbBlobStore } from './idb-blob-store.js'

// Its OWN database, not the app's — browser tests share an origin, so
// deleting `whiteboard` between cases would tear it out from under whatever
// other file is mid-fixture, and the failure would land there.
const DB_NAME = 'whiteboard-blob-store-conformance'

describe('IdbBlobStore', () => {
  describeBlobStoreConformance(async () => {
    await clearNamedDb(DB_NAME)
    return {
      store: new IdbBlobStore(DB_NAME),
      dispose: () => clearNamedDb(DB_NAME),
    }
  })
})
