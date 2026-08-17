import { Hono } from 'hono'
import type { ClientCountResponse } from '../../shared/api-contracts/document-runtime.js'
import { onDocumentAction } from './document/path-route.js'
import { getClientCount, getReadyClientCount } from './ws.js'

// Lightweight route for polling whether the browser connected after canvas_open.
// It only reads the WS connection map through getClientCount, so it stays O(1).
//
// Usage:
//   GET /api/w/:workspaceId/document/<path>/client-count → { count: number }
//
// When canvas_open uses waitForClient=true, poll this endpoint every 100 ms until
// count >= 1 or timeout. That avoids the canvas_open -> export_canvas race where
// export fails immediately with no_client.

export function createStatusRouter() {
  const app = new Hono()

  onDocumentAction(app, 'get', 'client-count', (c, workspaceId, path) => {
    const response: ClientCountResponse = {
      count: getClientCount(workspaceId, path),
      readyCount: getReadyClientCount(workspaceId, path),
    }
    return c.json(response)
  })

  return app
}
