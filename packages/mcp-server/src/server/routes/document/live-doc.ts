import type { ApiErrorBody, ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { onDocumentAction } from './path-route.js'

const documentMissing = (path: string) =>
  ({ error: 'not_found', message: `Document "${path}" not found` }) satisfies ApiErrorBody

// The engine answers in the shapes the loro-adapter readers return; this
// adapter asserts the type and holds no schema of its own for it.
const asserted = <T>() => ({ parse: (value: unknown) => value as T })

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
      return c.json(documentMissing(path), 404)
    }
    const snapshot = await deps.workspaceDocuments.withRecord(workspaceId, async (record) => {
      const entry = await record.read(
        { query: 'workspaceDocumentEntry', args: { path } },
        asserted<{ documentId: string } | null>(),
      )
      return entry === null ? null : record.exportProjection(entry.documentId)
    })
    // Gone between the existence check and the read: absent, as above.
    if (snapshot === null) return c.json(documentMissing(path), 404)
    return c.body(snapshot as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/octet-stream',
    })
  })

  return app
}
