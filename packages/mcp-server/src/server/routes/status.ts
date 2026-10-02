import { Hono } from 'hono'
import type { ClientCountResponse } from '../../shared/api-contracts/document-runtime.js'
import { getClientCount, getReadyClientCount } from '../sync-audience.js'
import { onDocumentAction } from './document/path-route.js'

// An operations probe: how many browsers are connected to a document, read
// over either transport (getClientCount). The product's own clients learn this
// from the sync stream, so nothing in the web app calls it; the extension's
// bridge smoke polls it to assert the daemon sees a page on its SSE stream.
//
// Usage:
//   GET /api/w/:workspaceId/document/<path>/client-count
//     → { count, readyCount }  (clientCountResponseSchema)
//
// `count` is every connected browser; `readyCount` the ones that have said
// client_ready.

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
