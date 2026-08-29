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
// Stays in REAL-browser mode on purpose: this file is part of the real-IDB
// fidelity contract (transaction/upgrade/abort semantics fake-indexeddb only
// approximates). IndexedDB-only suites with no such stake run in jsdom via
// fake-indexeddb instead — see e.g. local-document-summary.test.tsx.
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
    // No `onblocked` resolve. `blocked` fires when a connection is still open,
    // and the deletion happens only once it closes — so resolving there means
    // starting the next case against rows the previous one left, which every
    // conformance case assumes are gone. Waiting is safe here because
    // `IdbDocumentIndex` closes its connection in a `finally`, so nothing this
    // suite opens outlives its own call; if that ever stops being true, the
    // hang names this file rather than corrupting the case after it.
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

describe('IdbDocumentIndex', () => {
  describeDocumentIndexConformance(async () => {
    await deleteDb()
    const index = new IdbDocumentIndex(DB_NAME)
    return {
      index,
      dispose: deleteDb,
      // This index IS its own registry — one IndexedDB store holding the row
      // `createWorkspace` writes — so the seam is that call.
      seedWorkspace: async (entry) => index.createWorkspace(entry),
    }
  })
})
