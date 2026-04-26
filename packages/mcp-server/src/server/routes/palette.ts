import { Hono } from 'hono'
import { loadPalette, mergePaletteEntries, deletePaletteEntries } from '../store/palette-store.js'
import { validationErrorBody, validateWorkspaceId } from '../validators.js'

export function createPaletteRouter() {
  const app = new Hono()

  app.get('/api/workspaces/:workspaceId/palette', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (error) {
      const body = validationErrorBody(error)
      if (body) return c.json(body, 400)
      throw error
    }
    return c.json({ palette: await loadPalette(workspaceId) })
  })

  app.put('/api/workspaces/:workspaceId/palette', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (error) {
      const body = validationErrorBody(error)
      if (body) return c.json(body, 400)
      throw error
    }
    const body = await c.req.json<{ entries?: unknown }>()
    if (
      typeof body.entries !== 'object' ||
      body.entries === null ||
      Array.isArray(body.entries) ||
      Object.values(body.entries).some((value) => typeof value !== 'string')
    ) {
      return c.json({ error: 'invalid_body', message: 'entries must be Record<string, string>' }, 400)
    }
    return c.json({
      palette: await mergePaletteEntries(workspaceId, body.entries as Record<string, string>),
    })
  })

  app.delete('/api/workspaces/:workspaceId/palette', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (error) {
      const body = validationErrorBody(error)
      if (body) return c.json(body, 400)
      throw error
    }
    const body = await c.req.json<{ keys?: unknown }>()
    if (!Array.isArray(body.keys) || body.keys.some((value) => typeof value !== 'string')) {
      return c.json({ error: 'invalid_body', message: 'keys must be string[]' }, 400)
    }
    return c.json({ palette: await deletePaletteEntries(workspaceId, body.keys) })
  })

  return app
}
