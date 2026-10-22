import {
  documentContainers,
  reconcileCoreFacets,
  reconcileFacets,
  withDocumentBatch,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  BrowserWorkspaceDocs,
  openWorkspaceOrNull,
  saveAndAnnounce,
} from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import type { ImportedDocument } from './document-import.js'
import { touchContentTimestamp } from './loro-store.js'

/**
 * Writes an imported file's content into the node a create just made, as one
 * save of the workspace record — an ordinary CRDT edit, announced so a page
 * already open on the list sees the content without a reload.
 */
export async function writeImportedContent(
  documentId: string,
  imported: ImportedDocument,
  dbName?: string,
): Promise<void> {
  const docs = new BrowserWorkspaceDocs(dbName)
  const workspace = await openWorkspaceOrNull(docs)
  if (workspace === null) throw new Error('The workspace could not be opened to write the file.')
  const containers = documentContainers(workspace, documentId)
  if (imported.kind === 'markdown') {
    reconcileCoreFacets(containers, undefined, imported.coreFacets)
    reconcileFacets(containers, {}, imported.facets)
    withDocumentBatch(containers, (writer) => writer.writeMarkdownBody(imported.body))
  } else {
    withDocumentBatch(containers, (writer) =>
      writer.reconcileSpatialCanvas({ nodes: [], edges: [] }, imported.canvas),
    )
  }
  await saveAndAnnounce(docs, getBrowserWorkspaceId(), workspace)
  await touchContentTimestamp(documentId, dbName)
}
