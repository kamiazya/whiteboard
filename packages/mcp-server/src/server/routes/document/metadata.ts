import { Hono } from 'hono'
import {
  setNameRequestSchema,
  setPinnedRequestSchema,
} from '../../../shared/api-contracts/document.js'
import {
  loadWorkspaceNames,
  setDocumentDisplayName,
  setDocumentPinned,
  setWorkspaceName,
} from '../../store/names-store.js'
import { validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'
import { handleCorruptStoredData, handleDocumentNotFound } from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

// User-facing workspace / canvas names.
// When unnamed, the UI falls back to session id / path, so the API only returns stored values.
//
// GET /api/workspaces/:workspaceId/names
// PUT /api/workspaces/:workspaceId/name  body: { name: string } (empty string deletes)
// PUT /api/workspaces/:workspaceId/documents/:path/name  body: { name: string } (empty string deletes)
// PUT /api/workspaces/:workspaceId/documents/:path/pin  body: { pinned: boolean }
export function createDocumentMetadataRouter() {
  const app = new Hono()

  app.get('/api/workspaces/:workspaceId/names', async (c) => {
    const handle = c.req.param('workspaceId')
    try {
      validateWorkspaceId(handle)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const workspaceId = await workspaceIdFromHandle(c, handle)
    try {
      const names = await loadWorkspaceNames(workspaceId)
      return c.json(names)
    } catch (err) {
      const missing = handleDocumentNotFound(err)
      if (missing) return c.json(missing.body, missing.status)
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.put('/api/workspaces/:workspaceId/name', async (c) => {
    const handle = c.req.param('workspaceId')
    try {
      validateWorkspaceId(handle)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const workspaceId = await workspaceIdFromHandle(c, handle)
    const parsed = setNameRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400)
    }
    try {
      const updated = await setWorkspaceName(workspaceId, parsed.data.name)
      return c.json(updated)
    } catch (err) {
      const missing = handleDocumentNotFound(err)
      if (missing) return c.json(missing.body, missing.status)
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  onDocumentsRoute(app, 'put', ['name'], async (c, workspaceId, path) => {
    const parsed = setNameRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400)
    }
    try {
      const updated = await setDocumentDisplayName(workspaceId, path, parsed.data.name)
      return c.json(updated)
    } catch (err) {
      const missing = handleDocumentNotFound(err)
      if (missing) return c.json(missing.body, missing.status)
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // Idempotently set pin on/off and return the full updated WorkspaceNames payload.
  onDocumentsRoute(app, 'put', ['pin'], async (c, workspaceId, path) => {
    const parsed = setPinnedRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'pinned must be boolean' }, 400)
    }
    try {
      const updated = await setDocumentPinned(workspaceId, path, parsed.data.pinned)
      return c.json(updated)
    } catch (err) {
      const missing = handleDocumentNotFound(err)
      if (missing) return c.json(missing.body, missing.status)
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}
