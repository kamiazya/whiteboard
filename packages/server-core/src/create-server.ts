import type { Context } from 'hono'
import { Hono } from 'hono'
import type { ServerDeps } from './server-deps.js'
import {
  CanvasNotFoundError,
  CanvasParentNotFoundError,
  CanvasSegmentConflictError,
} from './tools/canvas-crud.errors.js'
import {
  createCanvasInputSchema,
  deleteCanvasInputSchema,
  getCanvasInputSchema,
  listCanvasesInputSchema,
} from './tools/canvas-crud.schemas.js'
import { wbCanvasCreate, wbCanvasDelete, wbCanvasGet, wbCanvasList } from './tools/canvas-crud.js'
import { createBodyPatchTool } from './tools/body-patch.js'
import { createCanvasDigestTool } from './tools/canvas-digest.js'
import { createCanvasExportJsonCanvasTool } from './tools/canvas-export-json-canvas.js'
import { createCanvasExportOkfTool } from './tools/canvas-export-okf.js'
import { createCanvasRenderSvgTool } from './tools/canvas-render-svg.js'
import { createEdgePatchTool } from './tools/edge-patch.js'
import { createFacetSetTool } from './tools/facet-set.js'
import { createNodePatchTool } from './tools/node-patch.js'

export function createServer(deps: ServerDeps) {
  const app = new Hono()

  app.post('/api/v1/workspaces/:workspaceId/canvases', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = createCanvasInputSchema.safeParse({
      workspaceId: c.req.param('workspaceId'),
      ...body,
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbCanvasCreate(deps, parsed.data)
      return c.json(result, 201)
    } catch (err) {
      return mapCanvasError(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/canvases', async (c) => {
    const parsed = listCanvasesInputSchema.safeParse({ workspaceId: c.req.param('workspaceId') })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    const result = await wbCanvasList(deps, parsed.data)
    return c.json(result, 200)
  })

  app.get('/api/v1/workspaces/:workspaceId/canvases/:canvasId', async (c) => {
    const parsed = getCanvasInputSchema.safeParse({
      workspaceId: c.req.param('workspaceId'),
      canvasId: c.req.param('canvasId'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbCanvasGet(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return mapCanvasError(c, err)
    }
  })

  app.delete('/api/v1/workspaces/:workspaceId/canvases/:canvasId', async (c) => {
    const parsed = deleteCanvasInputSchema.safeParse({
      workspaceId: c.req.param('workspaceId'),
      canvasId: c.req.param('canvasId'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbCanvasDelete(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return mapCanvasError(c, err)
    }
  })

  const tools = {
    facetSet: createFacetSetTool(deps),
    nodePatch: createNodePatchTool(deps),
    edgePatch: createEdgePatchTool(deps),
    bodyPatch: createBodyPatchTool(deps),
    canvasRenderSvg: createCanvasRenderSvgTool(deps),
    canvasDigest: createCanvasDigestTool(deps),
    canvasExportOkf: createCanvasExportOkfTool(deps),
    canvasExportJsonCanvas: createCanvasExportJsonCanvasTool(deps),
  }
  return { app, tools }
}

function mapCanvasError(c: Context, err: unknown) {
  if (err instanceof CanvasNotFoundError) {
    return c.json({ error: err.message }, 404)
  }
  if (err instanceof CanvasSegmentConflictError) {
    return c.json({ error: err.message }, 409)
  }
  if (err instanceof CanvasParentNotFoundError) {
    return c.json({ error: err.message }, 400)
  }
  throw err
}
