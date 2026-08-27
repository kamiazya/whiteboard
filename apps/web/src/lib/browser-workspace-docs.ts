/**
 * The browser's `WorkspaceDocs`: the shared `DocumentStore`-backed
 * implementation, composed over IndexedDB.
 *
 * This file used to hold the whole implementation. It moved to
 * `workspace-index` when the daemon needed one too and the diff between the
 * two would have been the constructor argument and nothing else — the
 * incremental-save shape (version comparison, delta append, fold at the
 * shared budget) is keeper-independent by construction, because it speaks
 * only the port.
 */
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { IdbDocumentStore } from './idb-document-store.js'

export class BrowserWorkspaceDocs extends DocumentStoreWorkspaceDocs {
  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  constructor(dbName?: string) {
    super(new IdbDocumentStore(dbName))
  }
}
