import {
  type DocumentContainers,
  holdsRetiredCommentPlane,
  resolveWorkspaceDocumentById,
  retiredStoredShapeIn,
} from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'

/**
 * Why a snapshot arriving in a sync session cannot be served, or null when it
 * can. Reported as a read failure rather than thrown into the session's
 * accessors, which would take React down with a doc it cannot serve anyway.
 *
 * A scoped session's contract with its backend is that the workspace bytes
 * hold its document's tree node; bytes that do not are unreadable FOR THIS
 * DOCUMENT. A record still in a shape no reader serves is refused by name,
 * since read as usual it would open without what the shape carried.
 */
export function unreadableSnapshot(
  arriving: LoroDoc,
  contentDocumentId: string | undefined,
  contentOf: (doc: LoroDoc) => DocumentContainers | null,
): 'corrupt-snapshot' | 'retired-comment-plane' | 'retired-stored-shape' | null {
  if (
    contentDocumentId !== undefined &&
    resolveWorkspaceDocumentById(arriving, contentDocumentId) === null
  ) {
    return 'corrupt-snapshot'
  }
  const content = contentOf(arriving)
  if (content === null) return null
  if (holdsRetiredCommentPlane(content)) return 'retired-comment-plane'
  if (retiredStoredShapeIn(content) !== null) return 'retired-stored-shape'
  return null
}
