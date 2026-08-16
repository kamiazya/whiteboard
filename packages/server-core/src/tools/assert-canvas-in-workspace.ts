import type { WorkspaceId } from '@kamiazya/whiteboard-canvas-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-canvas-ports'
import { CanvasNotFoundError } from './canvas-crud.errors.js'

/**
 * Guards a mutation tool against a caller-supplied `workspaceId` that does
 * not actually own `canvasId` (stale cached id, copy-paste across two open
 * canvases, client bug). Without this check a mismatched pair would still
 * pass every canvas-doc-level validation — `loadDocument`/
 * `loadOrCreateDocument` address the doc purely by `canvasId`, with no
 * cross-check against placement. Call this before any mutation so the caller
 * gets an explicit, typed rejection instead of silently writing into the
 * wrong workspace's canvas.
 */
export async function assertCanvasInWorkspace(
  documentIndex: DocumentIndex,
  workspaceId: WorkspaceId,
  canvasId: string,
): Promise<void> {
  const entry = await documentIndex.resolveDocumentById({ workspaceId, canvasId })
  if (entry === null) throw new CanvasNotFoundError(workspaceId, canvasId)
}
