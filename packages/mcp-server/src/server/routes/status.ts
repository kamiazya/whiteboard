import { Hono } from 'hono'
import type { ClientCountResponse } from '../../shared/api-contracts/document-runtime.js'
import { onDocumentAction } from './document/path-route.js'
import { getClientCount, getReadyClientCount } from './sync-audience.js'

// Lightweight route for polling whether a browser has connected to a canvas.
// It reads the browsers on the document over either transport (getClientCount).
//
// Usage:
//   GET /api/w/:workspaceId/document/<path>/client-count → { count: number }
//
// A caller that has just asked for the canvas to be opened polls this every
// 100 ms until count >= 1 or it times out, rather than acting immediately and
// failing with no_client.

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
