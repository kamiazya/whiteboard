import type { DocumentWritten } from '@kamiazya/whiteboard-server-core'
import { checkpointAfterWrite } from './auto-checkpoint.js'
import { scheduleAutoCompact } from './auto-compact.js'
import { documentStoreReady } from './store-handles.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import { FileVersionStore } from './version-store.js'

/**
 * What this composition root does after an agent write: debounce a
 * compaction of the op-log, exactly as the HTTP write path already did
 * through `setDocumentSavedListener`, and signal the automatic history
 * checkpoint the HTTP update path signals.
 *
 * The checkpoint is not optional for compaction's sake: `compactWorkspace`
 * declines `no-versions` until a history row exists, so a workspace only an
 * agent edits compacted nothing and showed no History however long it ran.
 *
 * It exists because that listener was the ONLY trigger. The agent write
 * path (a tool's save, such as `wb_canvas_edit`'s) reached the store directly
 * and fired nothing, so a document only an agent ever touched grew its op-log
 * without bound. The
 * seam is called from the write itself, so it works in every root — stdio
 * included, which mounts no router and runs no HTTP save subscription. What a
 * root has to do is install the checkpoint scheduler this signals (the
 * `auto-checkpoint` declaration); until it does, only the compaction half
 * has an effect.
 *
 * Compaction needs only the workspace: it folds the WORKSPACE record, which
 * every document shares. The checkpoint is per document and addressed by path,
 * which the writer already holds; the state it would record is the stored
 * record's frontier, read from the keeper when the checkpoint is about to be
 * taken rather than carried from the write.
 *
 * Deliberately NOT placed in document-store.ts beside `documentTeardown`,
 * which is where it belongs by subject: `auto-compact.ts` imports
 * `compactWorkspace` from there, so that would close an import cycle
 * `cycle-check.ts` rejects.
 */
export function createDocumentWritten(scope: StoreScope = globalStoreScope): DocumentWritten {
  // The version vector the keeper last persisted for the record. The
  // scheduler only asks whether it moved, and which space a frontier is in
  // does not matter to that, only that the same state reads the same.
  const recordFrontier = (workspaceId: string) => async (): Promise<Uint8Array> => {
    const stored = await (await documentStoreReady(scope)).readFrontier({
      docRef: { kind: 'workspace-tree', workspaceId },
    })
    return stored === null ? new Uint8Array() : stored.frontier
  }
  return async ({ workspaceId, path }) => {
    scheduleAutoCompact(workspaceId, new FileVersionStore(scope), { scope })
    if (path !== undefined) checkpointAfterWrite(workspaceId, path, recordFrontier(workspaceId))
  }
}
