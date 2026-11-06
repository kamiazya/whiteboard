/**
 * The probe for the per-document rows older builds wrote, which is what the
 * browser keeper refuses a workspace on. Its registry half is held to the
 * port's conformance suite through `BrowserDocumentIndex`, which keeps its
 * workspaces here.
 */
// Stays in REAL-browser mode on purpose: this file is part of the real-IDB
// fidelity contract (transaction/upgrade/abort semantics fake-indexeddb only
// approximates). IndexedDB-only suites with no such stake run in jsdom via
// fake-indexeddb instead — see e.g. browser-document-summary.test.tsx.
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import { seedLegacyRow } from '../test-utils/seed-legacy-row.js'
import { DOCUMENT_INDEX_STORE } from './browser-idb.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { inTransaction, request } from './idb-tx.js'

// Its OWN database, not the app's. Browser tests share an origin, so deleting
// `whiteboard` between cases would tear it out from under whatever other file
// is mid-fixture — and the failure would land there, in a test that did
// nothing wrong. Measured: it did exactly that to
// `browser-idb-migration.browser.test.tsx`.
const DB_NAME = 'whiteboard-document-index-conformance'

describe('IdbDocumentIndex.holdsPreTreeRecords', () => {
  it('answers for the workspace holding a row, and for no other', async () => {
    await clearNamedDb(DB_NAME)
    try {
      await seedLegacyRow({ workspaceId: 'ws', path: 'a', kind: 'spatial' }, DB_NAME)
      const index = new IdbDocumentIndex(DB_NAME)
      expect(await index.holdsPreTreeRecords('ws')).toBe(true)
      expect(await index.holdsPreTreeRecords('elsewhere')).toBe(false)
    } finally {
      await clearNamedDb(DB_NAME)
    }
  })

  it('counts a row it could not parse: any row there is a document the tree does not hold', async () => {
    await clearNamedDb(DB_NAME)
    try {
      const index = new IdbDocumentIndex(DB_NAME)
      await index.createWorkspace({ workspaceId: 'ws' })
      expect(await index.holdsPreTreeRecords('ws')).toBe(false)
      // `path` as a number is still a valid IndexedDB key, so nothing below
      // a schema would refuse it — and nothing here reads it through one.
      await inTransaction(DB_NAME, [DOCUMENT_INDEX_STORE], 'readwrite', async (tx) => {
        await request(
          tx
            .objectStore(DOCUMENT_INDEX_STORE)
            .put({ workspaceId: 'ws', documentId: generateDocumentId(), path: 42 }),
        )
      })
      expect(await index.holdsPreTreeRecords('ws')).toBe(true)
    } finally {
      await clearNamedDb(DB_NAME)
    }
  })
})
