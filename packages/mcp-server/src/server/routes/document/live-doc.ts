import type { ApiErrorBody, ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { onDocumentAction } from './path-route.js'

export interface LiveDocRouterOptions {
  // The live-document seam the route reads through, handed down from
  // document.ts.
  serverDeps: ServerDeps
}

// GET /api/workspaces/:workspaceId/documents/:documentId/snapshot
//
// A translation-only adapter (ADR-0018) over the LiveDocuments seam: one
// document's content, by path, as Loro snapshot bytes. Nothing writes ONE
// document's content over HTTP — editors sync the workspace record through
// the workspace-document routes, and a duplicate is its own route — so this
// read is the whole of the per-document live surface. Its readers are
// one-off reads outside sync: the web app's embed loader and thumbnail
// source.
export function createLiveDocRouter(options: LiveDocRouterOptions) {
  const app = new Hono()
  const deps = options.serverDeps

  onDocumentAction(app, 'get', 'snapshot', async (c, workspaceId, path) => {
    // get()'s lazy-create would otherwise silently hand back an empty
    // doc for a document that does not exist — indistinguishable from a
    // never-created OR just-deleted document. Spoken in `{ error, message }`
    // like the workspace refusal in front of this route, so one route does not
    // answer "absent" in two body families; every reader goes through
    // `apiErrorReason`, which takes either.
    if (!(await deps.liveDocuments.exists(workspaceId, path))) {
      return c.json(
        { error: 'not_found', message: `Document "${path}" not found` } satisfies ApiErrorBody,
        404,
      )
    }
    const doc = await deps.liveDocuments.get(workspaceId, path)
    const snapshot = doc.export({ mode: 'snapshot' }) as Uint8Array<ArrayBuffer>
    return c.body(snapshot, 200, {
      'Content-Type': 'application/octet-stream',
    })
  })

  return app
}
