import { resolveWorkspaceDocumentById } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentWritten } from '@kamiazya/whiteboard-server-core'

import { getDataDir } from '../config.js'
import { scheduleAutoCompact } from './auto-compact.js'
import { prepareDataDir } from './db/prepare.js'
import { openWorkspaceDocIfStored } from './document-store.js'
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
 * Deliberately NOT placed in document-store.ts beside `documentTeardown`,
 * which is where it belongs by subject: `auto-compact.ts` imports
 * `compactDocument` from there, so that would close an import cycle
 * `cycle-check.ts` rejects.
 */
export const documentWritten: DocumentWritten = async ({ workspaceId, documentId }) => {
  const dataDir = getDataDir()
  await prepareDataDir(dataDir)
  // The compaction path addresses a document by (workspaceId, path) while a
  // tool call knows the workspace and the id, so this is the one lookup that
  // bridges them. It runs once per save rather than per operation.
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc === null) return
  // A write to a document the tree has not been told about is possible — a
  // tool can save bytes for an id with no placement — and there is nothing
  // to compact under a name that does not exist.
  const entry = resolveWorkspaceDocumentById(workspaceDoc, documentId)
  if (entry === null) return
  scheduleAutoCompact(workspaceId, entry.path, new FileVersionStore())
}
