import type { WorkspaceId } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'

/**
 * Guards a mutation tool against a caller-supplied `workspaceId` that does
 * not actually own `documentId` (stale cached id, copy-paste across two open
 * documents, client bug). Without this check a mismatched pair would still
 * pass every canvas-doc-level validation — `loadDocument`/
 * `loadOrCreateDocument` address the doc purely by `documentId`, with no
 * cross-check against placement. Call this before any mutation so the caller
 * gets an explicit, typed rejection instead of silently writing into the
 * wrong workspace's canvas.
 */
export async function assertDocumentInWorkspace(
  documentIndex: DocumentIndex,
  workspaceId: WorkspaceId,
  documentId: string,
): Promise<void> {
  const entry = await documentIndex.resolveDocumentById({ workspaceId, documentId })
  if (entry === null) throw new WorkspaceDocumentNotFoundError(workspaceId, documentId)
}
