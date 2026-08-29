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
import type { LoroDoc } from 'loro-crdt'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { IdbDocumentStore } from './idb-document-store.js'

export class BrowserWorkspaceDocs extends DocumentStoreWorkspaceDocs {
  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  constructor(dbName?: string) {
    super(new IdbDocumentStore(dbName))
  }
}

/**
 * The workspace record, or null for BOTH an unreadable store and an
 * unavailable workspace id.
 *
 * The id read has to sit INSIDE the isolation, which is why this is a
 * function rather than the `docs.open(getBrowserWorkspaceId()).catch(…)` each
 * caller would otherwise write: an argument is evaluated before `open`
 * returns a promise, so an accessor throw is not a rejection that `.catch`
 * can absorb — it escapes the caller entirely, past the very null branch the
 * caller wrote to stay standing when storage is unavailable.
 */
export async function openWorkspaceOrNull(docs: BrowserWorkspaceDocs): Promise<LoroDoc | null> {
  try {
    return await docs.open(getBrowserWorkspaceId())
  } catch {
    return null
  }
}
