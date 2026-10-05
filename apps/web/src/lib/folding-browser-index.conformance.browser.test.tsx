/**
 * The production browser index, held to the port's own conformance suite —
 * the same bar `IdbDocumentIndex` and `LoroWorkspaceDocumentIndex` already
 * pass. Real IndexedDB on purpose: this class composes three IDB-backed
 * collaborators, and the suite's transactional claims are about the real
 * thing.
 *
 * Each case gets its OWN database (a counter-suffixed name passed to every
 * collaborator through the constructor) rather than deleting one shared name
 * between cases: the collaborators hold connections whose close timing this
 * file does not own, and a blocked `deleteDatabase` would hand the next case
 * the previous one's rows. A fresh name cannot be stale.
 */
import {
  describeDocumentIndexConformance,
  describeDocumentPinsConformance,
  describeDocumentTrashConformance,
} from '@kamiazya/whiteboard-ports/test-utils'
import { describe } from 'vitest'
import { BLOBS_STORE, openWhiteboardDb, WORKSPACES_STORE } from './browser-idb.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { inTransaction, request } from './idb-tx.js'

let caseN = 0

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name)
    // Best-effort: a blocked deletion is fine here because no later case
    // reuses this name.
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

async function freshIndex(): Promise<{ index: FoldingBrowserIndex; dbName: string }> {
  caseN += 1
  const dbName = `whiteboard-folding-conformance-${caseN}`
  await deleteDb(dbName)
  return { index: new FoldingBrowserIndex(dbName), dbName }
}

/** Every blob the index's store holds; the trash suite only evacuates documents. */
async function blobCount(dbName: string): Promise<number> {
  const db = await openWhiteboardDb(dbName)
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = db.transaction(BLOBS_STORE, 'readonly').objectStore(BLOBS_STORE).count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

describe('FoldingBrowserIndex', () => {
  describeDocumentIndexConformance(async () => {
    const { index, dbName } = await freshIndex()
    return {
      index,
      dispose: () => deleteDb(dbName),
      // The workspace record through the port's own call, then the registry
      // row as stored: `createWorkspace` refuses a layer the model refuses,
      // and the seam stands for whatever a registry already holds.
      seedWorkspace: async (entry) => {
        await index.createWorkspace({ workspaceId: entry.workspaceId })
        await inTransaction(dbName, [WORKSPACES_STORE], 'readwrite', async (tx) => {
          await request(tx.objectStore(WORKSPACES_STORE).put(entry, entry.workspaceId))
        })
      },
    }
  })
})

// The class declares the pins and trash ports too, and the browser's pinned
// list and trash are served from it — so it is held to their suites, not only
// to the one its inner index already passes.
describe('FoldingBrowserIndex pins', () => {
  describeDocumentPinsConformance(async () => {
    const { index, dbName } = await freshIndex()
    return { index, dispose: () => deleteDb(dbName) }
  })
})

describe('FoldingBrowserIndex trash', () => {
  describeDocumentTrashConformance(async () => {
    const { index, dbName } = await freshIndex()
    return {
      index,
      evacuatedBlobCount: () => blobCount(dbName),
      dispose: () => deleteDb(dbName),
    }
  })
})
