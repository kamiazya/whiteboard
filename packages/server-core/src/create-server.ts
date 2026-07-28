import type { BlobStore, CanvasDocStore, WorkspaceIndex } from '@kamiazya/whiteboard-canvas-ports'
import { Hono } from 'hono'
import { createFacetSetTool } from './tools/facet-set.js'

export interface ServerDeps {
  canvasDocStore: CanvasDocStore
  workspaceIndex: WorkspaceIndex
  blobStore: BlobStore
}

export function createServer(deps: ServerDeps) {
  const app = new Hono()
  const tools = {
    facetSet: createFacetSetTool(deps),
  }
  return { app, tools }
}
