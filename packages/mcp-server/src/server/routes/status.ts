import { Hono } from 'hono'
import { type ClientCountResponse } from '../../shared/api-contracts/canvas-runtime.js'
import { getClientCount, getReadyClientCount } from './ws.js'
import { validationErrorBody, validateWorkspaceId, validateSlug } from '../validators.js'

// Lightweight route for polling whether the browser connected after canvas_open.
// It only reads the WS connection map through getClientCount, so it stays O(1).
//
// Usage:
//   GET /api/canvas/:workspaceId/:slug/client-count → { count: number }
//
// When canvas_open uses waitForClient=true, poll this endpoint every 100 ms until
// count >= 1 or timeout. That avoids the canvas_open -> export_png race where
// export fails immediately with no_client.

export function createStatusRouter() {
  const app = new Hono()

  app.get('/api/canvas/:workspaceId/:slug/client-count', (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const response: ClientCountResponse = {
      count: getClientCount(workspaceId, slug),
      readyCount: getReadyClientCount(workspaceId, slug),
    }
    return c.json(response)
  })

  return app
}
