import type { DocumentSession } from '../document-session.js'
import { kindOf } from '../document-session-reads.js'
import type { ServerDeps } from '../server-deps.js'
import { NotASpatialDocumentError } from './not-a-spatial-document-error.js'

/**
 * Refuses a document KNOWN to be markdown: the doc's own recorded kind
 * wins, the workspace-scoped index row is the fallback (mirroring
 * wb_document_get's read path). A document with no recorded kind anywhere
 * passes — pre-kind spatial documents must keep working, so only a
 * positively-known markdown document is refused.
 */
export async function assertSpatialDocument(
  deps: ServerDeps,
  session: DocumentSession,
  toolName: string,
): Promise<void> {
  const { workspaceId, documentId } = session
  const docKind = await kindOf(session)
  const kind =
    docKind ?? (await deps.documentIndex.resolveDocumentById({ workspaceId, documentId }))?.kind
  if (kind === 'markdown') {
    throw new NotASpatialDocumentError(documentId, kind, toolName)
  }
}
