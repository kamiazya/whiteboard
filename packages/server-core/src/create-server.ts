import type { BlobStore, CanvasDocStore, WorkspaceIndex } from '@kamiazya/whiteboard-canvas-ports'
import { Hono } from 'hono'

export interface ServerDeps {
  canvasDocStore: CanvasDocStore
  workspaceIndex: WorkspaceIndex
  blobStore: BlobStore
}

export function createServer(deps: ServerDeps) {
  void deps
  const app = new Hono()
  return { app }
}
