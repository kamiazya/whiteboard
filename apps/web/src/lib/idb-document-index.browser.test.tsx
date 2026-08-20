/**
 * The browser `DocumentIndex`, held to the port's own conformance suite.
 *
 * `describeDocumentIndexConformance` was written as a factory for exactly
 * this second implementation — its doc comment names it — so this file adds
 * no assertions of its own beyond the ones the contract already states. What
 * it does add is the IndexedDB-specific fixture: a real database per case,
 * deleted afterwards, because the conformance cases assume an index that
 * starts empty.
 */
import { describeDocumentIndexConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe } from 'vitest'
import { IdbDocumentIndex } from './idb-document-index.js'

// Its OWN database, not the app's. Browser tests share an origin, so deleting
// `whiteboard` between conformance cases would tear it out from under whatever
// other file is mid-fixture — and the failure would land there, in a test that
// did nothing wrong. Measured: it did exactly that to
// `browser-idb-migration.browser.test.tsx`.
const DB_NAME = 'whiteboard-document-index-conformance'

async function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
}

describe('IdbDocumentIndex', () => {
  describeDocumentIndexConformance(async () => {
    await deleteDb()
    return {
      index: new IdbDocumentIndex(DB_NAME),
      dispose: deleteDb,
    }
  })
})
