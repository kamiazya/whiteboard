import type { documentEngine as wire } from '@kamiazya/whiteboard-model'
import { editWorkspaceRecord } from './browser-record-edit.js'
import { touchContentTimestamp } from './content-timestamp.js'
import type { ImportedDocument } from './document-import.js'

/** The writes that put an imported file's content into the node a create just made. */
function importWrites(documentId: string, imported: ImportedDocument): wire.Write[] {
  if (imported.kind === 'markdown') {
    return [
      {
        op: 'reconcileCoreFacets',
        args: { documentId, next: imported.coreFacets },
      },
      { op: 'reconcileFacets', args: { documentId, prev: {}, next: imported.facets } },
      {
        op: 'withDocumentBatch',
        args: { documentId, steps: [{ op: 'writeMarkdownBody', body: imported.body }] },
      },
    ]
  }
  return [
    {
      op: 'withDocumentBatch',
      args: {
        documentId,
        steps: [
          {
            op: 'reconcileSpatialCanvas',
            prev: { nodes: [], edges: [] },
            next: imported.canvas,
          },
        ],
      },
    },
  ]
}

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
  await editWorkspaceRecord(
    'The workspace could not be opened to write the file.',
    dbName,
    async () => ({ value: undefined, writes: importWrites(documentId, imported) }),
  )
  await touchContentTimestamp(documentId, dbName)
}
