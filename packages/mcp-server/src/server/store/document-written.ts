import type { DocumentWritten } from '@kamiazya/whiteboard-server-core'
import { checkpointAfterWrite } from './auto-checkpoint.js'
import { scheduleAutoCompact } from './auto-compact.js'
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
 * path (`wb_canvas_edit` -> `saveDocumentBodySnapshot` ->
 * `saveDocumentSnapshot`) reached the store directly and fired nothing, so
 * a canvas only an agent ever touched grew its op-log without bound. The
 * seam is called from the write itself, so it works in every root — stdio
 * included, which mounts no router and runs no HTTP save subscription. What a
 * root has to do is install the checkpoint scheduler this signals (the
 * `auto-checkpoint` declaration); until it does, only the compaction half
 * has an effect.
 *
 * Compaction needs only the workspace: it folds the WORKSPACE record, which
 * every document shares. The checkpoint is per document, so the path and doc
 * come from the writer, which already holds them.
 *
 * Deliberately NOT placed in document-store.ts beside `documentTeardown`,
 * which is where it belongs by subject: `auto-compact.ts` imports
 * `compactWorkspace` from there, so that would close an import cycle
 * `cycle-check.ts` rejects.
 */
export const documentWritten: DocumentWritten = async ({ workspaceId, path, doc }) => {
  scheduleAutoCompact(workspaceId, new FileVersionStore())
  if (path !== undefined) checkpointAfterWrite(workspaceId, path, doc)
}
