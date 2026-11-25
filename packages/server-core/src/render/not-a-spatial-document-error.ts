import {
  NotASpatialDocument,
  REFUSAL_CODE_NOT_A_SPATIAL_DOCUMENT,
} from '@kamiazya/whiteboard-model'

/**
 * Thrown when a scene tool is pointed at a document whose kind says it is
 * not spatial. Without this, a markdown document — whose body lives outside
 * the nodes/edges containers — digested or rendered as an EMPTY scene with
 * no error, indistinguishable from a genuinely empty spatial canvas.
 */
export class NotASpatialDocumentError extends Error {
  readonly code = REFUSAL_CODE_NOT_A_SPATIAL_DOCUMENT

  constructor(documentId: string, kind: string, toolName: string) {
    super(NotASpatialDocument(documentId, kind, toolName))
    this.name = 'NotASpatialDocumentError'
  }
}
