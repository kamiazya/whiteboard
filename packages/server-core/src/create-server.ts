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

export type { ServerDeps } from './server-deps.js'

// Server-core is a shared-layer package (no node:*, no logger abstraction
// exists here yet — see .claude/rules/package-server-core.md). Route
// handlers below deliberately do not log caught errors; that responsibility
// stays with a composition root (mcp-server / apps/web) once one wraps this
// factory with its own `getLogger`-backed middleware.
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

  return { app }
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
