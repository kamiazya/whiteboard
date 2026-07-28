import type { BlobStore, CanvasDocStore, WorkspaceIndex } from '@kamiazya/whiteboard-canvas-ports'

export interface ServerDeps {
  canvasDocStore: CanvasDocStore
  workspaceIndex: WorkspaceIndex
  blobStore: BlobStore
}
