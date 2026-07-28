import type { BlobStore, CanvasDocStore, WorkspaceIndex } from '@kamiazya/whiteboard-canvas-ports'
import { Hono } from 'hono'
import { createCanvasDigestTool } from './tools/canvas-digest.js'
import { createCanvasExportJsonCanvasTool } from './tools/canvas-export-json-canvas.js'
import { createCanvasExportOkfTool } from './tools/canvas-export-okf.js'
import { createCanvasRenderSvgTool } from './tools/canvas-render-svg.js'
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
    canvasRenderSvg: createCanvasRenderSvgTool(deps),
    canvasDigest: createCanvasDigestTool(deps),
    canvasExportOkf: createCanvasExportOkfTool(deps),
    canvasExportJsonCanvas: createCanvasExportJsonCanvasTool(deps),
  }
  return { app, tools }
}
