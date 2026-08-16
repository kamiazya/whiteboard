import { Hono } from 'hono'
import {
  setNameRequestSchema,
  setPinnedRequestSchema,
} from '../../../shared/api-contracts/canvas.js'
import {
  loadWorkspaceNames,
  setCanvasName,
  setCanvasPinned,
  setWorkspaceName,
} from '../../store/names-store.js'
import { validateDocumentPath, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { handleCorruptStoredData } from './_shared.js'
import { onCanvasesRoute } from './path-route.js'

// User-facing workspace / canvas names.
// When unnamed, the UI falls back to session id / path, so the API only returns stored values.
//
// GET /api/workspaces/:workspaceId/names
// PUT /api/workspaces/:workspaceId/name  body: { name: string } (empty string deletes)
// PUT /api/workspaces/:workspaceId/canvases/:path/name  body: { name: string } (empty string deletes)
// PUT /api/workspaces/:workspaceId/canvases/:path/pin  body: { pinned: boolean }
export function createCanvasMetadataRouter() {
  const app = new Hono()

  app.get('/api/workspaces/:workspaceId/names', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const names = await loadWorkspaceNames(workspaceId)
      return c.json(names)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.put('/api/workspaces/:workspaceId/name', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const parsed = setNameRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400)
    }
    try {
      const updated = await setWorkspaceName(workspaceId, parsed.data.name)
      return c.json(updated)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  onCanvasesRoute(app, 'put', ['name'], async (c, workspaceId, path) => {
    const parsed = setNameRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400)
    }
    try {
      const updated = await setCanvasName(workspaceId, path, parsed.data.name)
      return c.json(updated)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // Idempotently set pin on/off and return the full updated WorkspaceNames payload.
  onCanvasesRoute(app, 'put', ['pin'], async (c, workspaceId, path) => {
    const parsed = setPinnedRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'pinned must be boolean' }, 400)
    }
    try {
      const updated = await setCanvasPinned(workspaceId, path, parsed.data.pinned)
      return c.json(updated)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}
