import type { BlobStore, CanvasDocStore, WorkspaceIndex } from '@kamiazya/whiteboard-canvas-ports'
import { Hono } from 'hono'
import { createBodyPatchTool } from './tools/body-patch.js'
import { createEdgePatchTool } from './tools/edge-patch.js'
import { createFacetSetTool } from './tools/facet-set.js'
import { createNodePatchTool } from './tools/node-patch.js'

export interface ServerDeps {
  canvasDocStore: CanvasDocStore
  workspaceIndex: WorkspaceIndex
  blobStore: BlobStore
}

export function createServer(deps: ServerDeps) {
  const app = new Hono()
  const tools = {
    facetSet: createFacetSetTool(deps),
    nodePatch: createNodePatchTool(deps),
    edgePatch: createEdgePatchTool(deps),
    bodyPatch: createBodyPatchTool(deps),
  }
  return { app, tools }
}
