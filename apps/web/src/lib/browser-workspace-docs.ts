/**
 * The browser's `WorkspaceDocs`: the shared `DocumentStore`-backed
 * implementation, composed over IndexedDB.
 *
 * The implementation lives in `workspace-index`, shared with the daemon: the
 * two differ in nothing but the constructor argument — the incremental-save
 * shape (version comparison, delta append, fold at the shared budget) is
 * keeper-independent by construction, because it speaks only the port.
 */
import {
  DocumentStoreWorkspaceDocs,
  type WorkspaceDocs,
} from '@kamiazya/whiteboard-workspace-index'
import type { LoroDoc } from 'loro-crdt'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { openDocumentStore } from './replica-store.js'
import { listenToWorkspace, type WorkspaceBroadcastEnd } from './workspace-broadcast.js'

export class BrowserWorkspaceDocs extends DocumentStoreWorkspaceDocs {
  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  constructor(dbName?: string) {
    super(openDocumentStore(dbName))
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

/**
 * Saves the workspace record and tells every page holding it, with the bytes
 * the save wrote: the `update` an open page's backend merges as another tab's
 * edit. A write to a document's CONTENT goes through here, because a page
 * merges another writer's content only from that message — a write that
 * skipped it sat on disk, unseen by every open page until a reload. (The
 * index's own writes announce what they changed by name instead, and a holder
 * catches up from the record.)
 *
 * `through` is the end to post on. A backend passes its own, which a sending
 * object never hears, so its own edit is not merged into it twice (`null`
 * once it has closed). Absent, a fresh end posts, which reaches this tab's
 * open pages as well as the other tabs'.
 */
export async function saveAndAnnounce(
  docs: WorkspaceDocs,
  workspaceId: string,
  record: LoroDoc,
  through?: WorkspaceBroadcastEnd | null,
): Promise<void> {
  const persisted = await docs.save(workspaceId, record)
  if (persisted === null) return
  const message = { type: 'update', bytes: persisted } as const
  if (through !== undefined) {
    through?.post(message)
    return
  }
  const end = listenToWorkspace(workspaceId, () => {})
  end.post(message)
  end.close()
}
