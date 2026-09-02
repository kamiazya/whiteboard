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
import { describeDocumentIndexConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe } from 'vitest'
import { FoldingBrowserIndex } from './folding-browser-index.js'

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

describe('FoldingBrowserIndex', () => {
  describeDocumentIndexConformance(async () => {
    caseN += 1
    const dbName = `whiteboard-folding-conformance-${caseN}`
    await deleteDb(dbName)
    const index = new FoldingBrowserIndex(dbName)
    return {
      index,
      dispose: () => deleteDb(dbName),
      // createWorkspace persists identity into the registry the class
      // resolves against, so the port's own call is the seam.
      seedWorkspace: (entry) => index.createWorkspace(entry),
    }
  })
})
