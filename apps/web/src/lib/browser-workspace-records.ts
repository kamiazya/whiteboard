/**
 * The browser's workspace records held as engine leases: the same store and
 * the same mint refusal as `BrowserWorkspaceDocs`, over a record the caller
 * releases when it is done with it.
 */
import { leaseKind, loadCrdtEngine, type RecordLease } from '@kamiazya/whiteboard-loro-adapter'
import { RecordStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { isReplicaCopy, openDocumentStore } from './replica-store.js'
import { refuseUnlessHeld } from './workspace-tombstone.js'

export class BrowserWorkspaceRecords extends RecordStoreWorkspaceDocs<RecordLease> {
  /** Only tests pass `dbName`; see `BrowserWorkspaceDocs`. */
  constructor(dbName?: string) {
    super(openDocumentStore(dbName), leaseKind(loadCrdtEngine), {
      beforeMint: (workspaceId) =>
        refuseUnlessHeld(workspaceId, isReplicaCopy(workspaceId), dbName),
    })
  }
}
