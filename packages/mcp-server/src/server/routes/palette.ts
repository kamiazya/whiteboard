import { Hono } from 'hono'
import {
  type PaletteResponse,
  paletteDeleteRequestSchema,
  paletteSetRequestSchema,
} from '../../shared/api-contracts/palette.js'
import { deletePaletteEntries, loadPalette, mergePaletteEntries } from '../store/palette-store.js'
import { validateWorkspaceId, validationErrorBody } from '../validators.js'

function invalidBody(message: string) {
  return { error: 'invalid_body', message }
}

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
    const response: PaletteResponse = { palette: await loadPalette(workspaceId) }
    return c.json(response)
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
    const parsed = paletteSetRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(invalidBody('entries must be Record<string, string>'), 400)
    }
    const response: PaletteResponse = {
      palette: await mergePaletteEntries(workspaceId, parsed.data.entries),
    }
    return c.json(response)
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
    const parsed = paletteDeleteRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(invalidBody('keys must be a non-empty string[]'), 400)
    }
    const response: PaletteResponse = {
      palette: await deletePaletteEntries(workspaceId, parsed.data.keys),
    }
    return c.json(response)
  })

  return app
}
