import type { DocumentWritten } from '@kamiazya/whiteboard-server-core'

import { scheduleAutoCompact } from './auto-compact.js'
import { FileVersionStore } from './version-store.js'

/**
 * What this composition root does after an agent write: debounce a
 * compaction of the op-log, exactly as the HTTP write path already did
 * through `setDocumentSavedListener`.
 *
 * It exists because that listener was the ONLY trigger. The agent write
 * path (`wb_canvas_edit` -> `saveDocumentBodySnapshot` ->
 * `saveDocumentSnapshot`) reached the store directly and fired nothing, so
 * a canvas only an agent ever touched grew its op-log without bound. Worse
 * in stdio MCP: `installAutoCompact` is called from the HTTP route
 * registration, which stdio never runs — traced from the stdio entry, 76
 * modules are reachable and `auto-compact.ts` is not among them, so there
 * was no emitter AND no subscriber.
 *
 * The document id goes unread: compaction folds the WORKSPACE record, which
 * every document shares, so the write's workspace is the whole address. This
 * used to open the workspace doc and resolve the id to a path on every agent
 * write, only so the scheduler could build a per-document key it then
 * collapsed anyway.
 *
 * Deliberately NOT placed in document-store.ts beside `documentTeardown`,
 * which is where it belongs by subject: `auto-compact.ts` imports
 * `compactWorkspace` from there, so that would close an import cycle
 * `cycle-check.ts` rejects.
 */
export const documentWritten: DocumentWritten = async ({ workspaceId }) => {
  scheduleAutoCompact(workspaceId, new FileVersionStore())
}
