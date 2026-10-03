import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '../server-deps.js'
import { loadDocument, saveDocumentSnapshot } from '../tools/document-io.js'

/**
 * Stores a node carrying `embed` straight into a spatial document. The tool
 * input does not publish `embed`, but a document read from elsewhere can hold
 * one, and the reference graph reads it — so fixtures for that reader seed it
 * below the tool.
 */
export async function seedEmbedNode(
  deps: ServerDeps,
  workspaceId: string,
  documentId: string,
  node: { id: string; targetDocumentId: string },
): Promise<void> {
  const { doc } = await loadDocument(deps, workspaceId, documentId)
  const canvas = readSpatialCanvas(doc)
  writeSpatialCanvas(doc, {
    ...canvas,
    nodes: [
      ...canvas.nodes,
      fileNode({
        id: node.id,
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        file: 'embed-placeholder',
        embed: { documentId: node.targetDocumentId },
      }),
    ],
  })
  await saveDocumentSnapshot(deps, workspaceId, documentId, doc)
}
