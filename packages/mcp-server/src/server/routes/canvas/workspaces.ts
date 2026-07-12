import { Hono } from 'hono'
import { LoroDoc as LoroDocCtor } from 'loro-crdt'
import {
  type CreateCanvasResponse,
  createCanvasRequestSchema,
  type ListCanvasesResponse,
  type ListWorkspacesResponse,
} from '../../../shared/api-contracts/canvas.js'
import { getLogger } from '../../log.js'
import {
  ConflictError,
  listCanvases,
  listWorkspaces,
  saveCanvas,
} from '../../store/canvas-store.js'
import { validateSlug, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { handleCorruptStoredData } from './shared.js'

// GET /api/workspaces
// GET /api/workspaces/:workspaceId/canvases
// POST /api/workspaces/:workspaceId/canvases  body: { slug: string }
export function createWorkspacesRouter() {
  const app = new Hono()

  app.get('/api/workspaces', async (c) => {
    try {
      const workspaces = await listWorkspaces()
      const response: ListWorkspacesResponse = {
        workspaces: workspaces.map(({ workspaceId }) => ({ workspaceId })),
      }
      return c.json(response)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.get('/api/workspaces/:workspaceId/canvases', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const canvases = await listCanvases(workspaceId)
      const response: ListCanvasesResponse = { canvases }
      return c.json(response)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // Save a new empty LoroDoc under slug. Return 409 for conflicts and 400 for invalid slugs.
  // On success, return { slug } for client-side navigation.
  app.post('/api/workspaces/:workspaceId/canvases', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json({ title: body.message }, 400)
      throw err
    }
    const raw = await c.req.json().catch(() => null)
    if (raw === null) {
      return c.json({ title: 'JSON body required' }, 400)
    }
    const parsed = createCanvasRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ title: 'slug is required' }, 400)
    }
    const slug = parsed.data.slug
    try {
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json({ title: body.message }, 400)
      throw err
    }
    try {
      const doc = new LoroDocCtor()
      await saveCanvas(workspaceId, slug, doc, { overwrite: false })
      const response: CreateCanvasResponse = { slug }
      return c.json(response)
    } catch (err) {
      if (err instanceof ConflictError) {
        return c.json({ title: `Canvas "${slug}" already exists` }, 409)
      }
      getLogger('canvas').error({ err: err as Error }, 'saveCanvas failed unexpectedly')
      return c.json({ title: 'Failed to create canvas.' }, 500)
    }
  })

  return app
}
