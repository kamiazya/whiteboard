import { writeWorkspaceDocumentContent } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { BrowserWorkspaceDocs, openWorkspaceOrNull } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { touchContentTimestamp } from '../lib/loro-store.js'

/**
 * Writes standalone-document bytes INTO an existing tree node and stamps its
 * listing clock, so a test can give a document content. Returns false when the
 * workspace record or the node is absent.
 */
export async function seedWorkspaceDocumentContent(
  documentId: string,
  content: Uint8Array,
  dbName?: string,
): Promise<boolean> {
  const docs = new BrowserWorkspaceDocs(dbName)
  const workspace = await openWorkspaceOrNull(docs)
  if (workspace === null) return false
  const source = new LoroDoc()
  source.import(content)
  if (!writeWorkspaceDocumentContent(workspace, documentId, source)) return false
  await docs.save(getBrowserWorkspaceId(), workspace)
  await touchContentTimestamp(documentId, dbName)
  return true
}
