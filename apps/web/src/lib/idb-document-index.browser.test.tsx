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
// fake-indexeddb instead — see e.g. browser-document-summary.test.tsx.
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { describeDocumentIndexConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import { DOCUMENT_INDEX_STORE, WORKSPACES_STORE } from './browser-idb.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { inTransaction, request } from './idb-tx.js'

// Its OWN database, not the app's. Browser tests share an origin, so deleting
// `whiteboard` between conformance cases would tear it out from under whatever
// other file is mid-fixture — and the failure would land there, in a test that
// did nothing wrong. Measured: it did exactly that to
// `browser-idb-migration.browser.test.tsx`.
const DB_NAME = 'whiteboard-document-index-conformance'

/** A registry row as stored, bypassing the class's own validated write. */
async function putRegistryRow(entry: WorkspaceEntry): Promise<void> {
  await inTransaction(DB_NAME, [WORKSPACES_STORE], 'readwrite', async (tx) => {
    await request(tx.objectStore(WORKSPACES_STORE).put(entry, entry.workspaceId))
  })
}

describe('IdbDocumentIndex row hydration', () => {
  it('a malformed stored row fails the read loudly instead of flowing into the UI as a DocumentEntry', async () => {
    await clearNamedDb(DB_NAME)
    try {
      const index = new IdbDocumentIndex(DB_NAME)
      await index.createWorkspace({ workspaceId: 'ws' })
      // Plant a corrupt row through the same transaction helper the class
      // uses, bypassing its own validated write path — the shape a buggy
      // writer, a devtools edit, or a future schema drift would leave
      // behind. `path` as a number is still a valid IndexedDB key, so
      // nothing below the schema refuses it.
      await inTransaction(DB_NAME, [DOCUMENT_INDEX_STORE], 'readwrite', async (tx) => {
        await request(
          tx
            .objectStore(DOCUMENT_INDEX_STORE)
            .put({ workspaceId: 'ws', documentId: generateDocumentId(), path: 42 }),
        )
      })
      // A cast would answer this with `path: 42` inside a DocumentEntry —
      // corrupt data wearing the contract's type. The schema names the field.
      await expect(index.listDocuments({ workspaceId: 'ws' })).rejects.toThrow(/path/)
    } finally {
      await clearNamedDb(DB_NAME)
    }
  })
})

describe('IdbDocumentIndex', () => {
  describeDocumentIndexConformance(async () => {
    await clearNamedDb(DB_NAME)
    const index = new IdbDocumentIndex(DB_NAME)
    return {
      index,
      dispose: () => clearNamedDb(DB_NAME),
      // This index IS its own registry, one IndexedDB store, so the seam
      // writes that store's row directly: `createWorkspace` refuses a layer
      // the model refuses, and the seam stands for whatever a registry holds.
      seedWorkspace: (entry) => putRegistryRow(entry),
    }
  })
})
