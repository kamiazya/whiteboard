import { Hono } from 'hono'
import { loadPalette, mergePaletteEntries, deletePaletteEntries } from '../store/palette-store.js'
import { validationErrorBody, validateSessionId } from '../validators.js'
import { registerWorkspaceAlias } from './workspace-alias.js'

export function createPaletteRouter() {
  const app = new Hono()

  registerWorkspaceAlias(app, 'get', '/api/sessions/:sessionId/palette', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
    } catch (error) {
      const body = validationErrorBody(error)
      if (body) return c.json(body, 400)
      throw error
    }
    return c.json({ palette: await loadPalette(sessionId) })
  })

  registerWorkspaceAlias(app, 'put', '/api/sessions/:sessionId/palette', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
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
      palette: await mergePaletteEntries(sessionId, body.entries as Record<string, string>),
    })
  })

  registerWorkspaceAlias(app, 'delete', '/api/sessions/:sessionId/palette', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
    } catch (error) {
      const body = validationErrorBody(error)
      if (body) return c.json(body, 400)
      throw error
    }
    const body = await c.req.json<{ keys?: unknown }>()
    if (!Array.isArray(body.keys) || body.keys.some((value) => typeof value !== 'string')) {
      return c.json({ error: 'invalid_body', message: 'keys must be string[]' }, 400)
    }
    return c.json({ palette: await deletePaletteEntries(sessionId, body.keys) })
  })

  return app
}
