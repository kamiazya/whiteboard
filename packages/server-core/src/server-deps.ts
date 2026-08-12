import type { BlobStore, CanvasDocStore } from '@kamiazya/whiteboard-canvas-ports'

export interface ServerDeps {
  canvasDocStore: CanvasDocStore
  blobStore: BlobStore
}
