/**
 * The row store's reads, which are what the startup fold depends on: the
 * listing it takes legacy rows from, and the retirement it ends each one
 * with. Its registry half is held to the port's conformance suite through
 * `FoldingBrowserIndex`, which keeps its workspaces here.
 */
// Stays in REAL-browser mode on purpose: this file is part of the real-IDB
// fidelity contract (transaction/upgrade/abort semantics fake-indexeddb only
// approximates). IndexedDB-only suites with no such stake run in jsdom via
// fake-indexeddb instead — see e.g. browser-document-summary.test.tsx.
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { WorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
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

describe('IdbDocumentIndex legacy rows', () => {
  it('lists a workspace in path order and refuses one it does not know', async () => {
    await clearNamedDb(DB_NAME)
    try {
      for (const path of ['b', 'a-b', 'a/c', 'a']) {
        await seedLegacyRow({ workspaceId: 'ws', path, kind: 'spatial' }, DB_NAME)
      }
      const index = new IdbDocumentIndex(DB_NAME)
      // The port's order, segment by segment, which is not IndexedDB's key
      // order: that one puts `a-b` before `a/c`, since `-` sorts below `/`.
      expect((await index.listDocuments({ workspaceId: 'ws' })).map((row) => row.path)).toEqual([
        'a',
        'a/c',
        'a-b',
        'b',
      ])
      // An error rather than an empty list, which a real but empty workspace
      // would also answer — the fold tells the two apart by it.
      await expect(index.listDocuments({ workspaceId: 'elsewhere' })).rejects.toBeInstanceOf(
        WorkspaceNotFoundError,
      )
    } finally {
      await clearNamedDb(DB_NAME)
    }
  })

  it('retires the row an id names, below-path rows included, and again without complaint', async () => {
    await clearNamedDb(DB_NAME)
    try {
      const parent = await seedLegacyRow({ workspaceId: 'ws', path: 'a', kind: 'spatial' }, DB_NAME)
      await seedLegacyRow({ workspaceId: 'ws', path: 'a/b', kind: 'spatial' }, DB_NAME)
      const index = new IdbDocumentIndex(DB_NAME)

      await index.retireDocument({ workspaceId: 'ws', documentId: parent.documentId })
      // An interrupted fold repeats its retirement, so a second one is a no-op.
      await index.retireDocument({ workspaceId: 'ws', documentId: parent.documentId })

      expect((await index.listDocuments({ workspaceId: 'ws' })).map((row) => row.path)).toEqual([
        'a/b',
      ])
    } finally {
      await clearNamedDb(DB_NAME)
    }
  })
})
