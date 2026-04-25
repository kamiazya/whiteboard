import { Hono } from 'hono'
import { getClientCount, getReadyClientCount } from './ws.js'
import { validationErrorBody, validateSessionId, validateSlug } from '../validators.js'

// Lightweight route for polling whether the browser connected after canvas_open.
// It only reads the WS connection map through getClientCount, so it stays O(1).
//
// Usage:
//   GET /api/canvas/:sessionId/:slug/client-count → { count: number }
//
// When canvas_open uses waitForClient=true, poll this endpoint every 100 ms until
// count >= 1 or timeout. That avoids the canvas_open -> export_png race where
// export fails immediately with no_client.

export function createStatusRouter() {
  const app = new Hono()

  app.get('/api/canvas/:sessionId/:slug/client-count', (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    return c.json({
      count: getClientCount(sessionId, slug),
      readyCount: getReadyClientCount(sessionId, slug),
    })
  })

  return app
}
