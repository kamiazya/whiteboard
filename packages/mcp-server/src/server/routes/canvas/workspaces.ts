import { Hono } from 'hono'
import { LoroDoc as LoroDocCtor } from 'loro-crdt'
import type { z } from 'zod'
import {
  type CreateCanvasResponse,
  createCanvasRequestSchema,
  type DeleteCanvasResponse,
  type ListCanvasesResponse,
  type ListWorkspacesResponse,
  type RenameCanvasSlugResponse,
  renameCanvasSlugRequestSchema,
} from '../../../shared/api-contracts/canvas.js'
import { getLogger } from '../../log.js'
import {
  ConflictError,
  deleteCanvas,
  listCanvases,
  listWorkspaces,
  renameCanvasSlug,
  saveCanvas,
  workspaceExists,
} from '../../store/canvas-store.js'
import { validateSlug, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { handleCorruptStoredData } from './_shared.js'
import { onCanvasesRoute } from './path-route.js'

// Names the specific field createCanvasRequestSchema rejected, instead of a
// single message covering the whole request — a valid slug with an invalid
// kind must not be told "slug is required", which names the wrong field and
// gives the caller no path to recovery.
function createCanvasRequestErrorTitle(error: z.ZodError): string {
  const issue = error.issues[0]
  const field = issue?.path[0]
  if (field === 'kind') return 'kind must be "spatial" or "markdown"'
  if (field === 'slug') return 'slug is required'
  return issue?.message ?? 'invalid request body'
}

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
      // "Empty" and "never registered" are different answers, and conflating
      // them is what let a stale pairing render as an empty workspace with a
      // Create button. Same problem-details shape as live-doc's snapshot 404.
      if (!(await workspaceExists(workspaceId))) {
        return c.json({ title: `Workspace "${workspaceId}" not found` }, 404)
      }
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
      return c.json({ title: createCanvasRequestErrorTitle(parsed.error) }, 400)
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
      await saveCanvas(workspaceId, slug, doc, { overwrite: false, kind: parsed.data.kind })
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

  // Delete a canvas: row (branches/versions cascade via FK), .loro blob,
  // version thumbnails, and doc-cache entry. Idempotent-shaped 404 for a
  // missing canvas rather than a throw.
  onCanvasesRoute(
    app,
    'delete',
    [],
    async (c, workspaceId, slug) => {
      try {
        const deleted = await deleteCanvas(workspaceId, slug)
        if (!deleted) {
          return c.json({ title: `Canvas "${slug}" not found` }, 404)
        }
        const response: DeleteCanvasResponse = { ok: true }
        return c.json(response)
      } catch (err) {
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        getLogger('canvas').error({ err: err as Error }, 'deleteCanvas failed unexpectedly')
        return c.json({ title: 'Failed to delete canvas.' }, 500)
      }
    },
    { badRequest: 'problem-details' },
  )

  // Rename a canvas's slug in place: same canvasId, same branches/versions/blob,
  // just a new slug column. Old URLs carrying the old slug 404 by design — no
  // redirect, no alias history (0.0.x).
  //
  // Server-side foundation only: no MCP tool, CLI command, or apps/web
  // affordance calls this route yet. The apps/web slug-edit UI is a planned
  // follow-up, not dead code.
  onCanvasesRoute(
    app,
    'put',
    ['slug'],
    async (c, workspaceId, slug) => {
      const raw = await c.req.json().catch(() => null)
      if (raw === null) {
        return c.json({ title: 'JSON body required' }, 400)
      }
      const parsed = renameCanvasSlugRequestSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ title: 'slug is required' }, 400)
      }
      const newSlug = parsed.data.slug
      try {
        validateSlug(newSlug)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json({ title: body.message }, 400)
        throw err
      }
      try {
        const result = await renameCanvasSlug(workspaceId, slug, newSlug)
        if (!result) {
          return c.json({ title: `Canvas "${slug}" not found` }, 404)
        }
        const response: RenameCanvasSlugResponse = { slug: newSlug }
        return c.json(response)
      } catch (err) {
        if (err instanceof ConflictError) {
          return c.json({ title: `Canvas "${newSlug}" already exists` }, 409)
        }
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        getLogger('canvas').error({ err: err as Error }, 'renameCanvasSlug failed unexpectedly')
        return c.json({ title: 'Failed to rename canvas.' }, 500)
      }
    },
    { badRequest: 'problem-details' },
  )

  return app
}
