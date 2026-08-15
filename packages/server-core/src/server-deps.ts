import type { BlobStore, CanvasDocStore, DocumentIndex } from '@kamiazya/whiteboard-canvas-ports'

export interface ServerDeps {
  canvasDocStore: CanvasDocStore
  blobStore: BlobStore
  /**
   * Where a document's placement lives. Separate from `canvasDocStore`, which
   * owns one document's bytes and knows nothing about where it sits — and the
   * reason an agent-created document is one the user's canvas list can show:
   * both surfaces now write the same index.
   */
  documentIndex: DocumentIndex
}
