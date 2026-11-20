import type { DocumentEdit } from '@kamiazya/whiteboard-loro-adapter'
import type { documentEngine as wire } from '@kamiazya/whiteboard-model'

/**
 * `edit` as the engine's writes against the document `documentId` names in a
 * workspace record: the same narrowest change `applyDocumentEdit` makes to a
 * Loro document, so a keeper that holds the record as an engine lease applies
 * a planner's plan without a Loro document of its own.
 */
export function documentEditWrites(documentId: string, edit: DocumentEdit): wire.Write[] {
  switch (edit.kind) {
    case 'markdown-splices':
      return [{ op: 'spliceText', args: { documentId, text: 'body', runs: edit.runs } }]
    case 'markdown-body':
      return [{ op: 'writeMarkdownBody', args: { documentId, body: edit.body } }]
    case 'spatial-nodes':
      return [
        {
          op: 'withSpatialBatch',
          args: {
            documentId,
            steps: edit.nodes.map((node) => ({ op: 'writeNode', node })),
          },
        },
      ]
    case 'spatial-canvas':
      return [
        {
          op: 'reconcileSpatialCanvas',
          args: { documentId, prev: edit.before, next: edit.after },
        },
      ]
  }
}
