import type { UpdateDocumentResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  type ApiErrorBody,
  applyDocumentUpdate,
  DocumentEngineTrapError,
  errorBody,
  type ServerDeps,
} from '@kamiazya/whiteboard-server-core'
import { type Context, Hono } from 'hono'
import { decodeImportBlobMeta, type LoroDoc } from 'loro-crdt'
import { CONTENT_BODY_LIMIT_BYTES, limitBody } from '../body-limit.js'
import { onDocumentAction } from './path-route.js'

export interface LiveDocRouterOptions {
  triggerAutoVersion: (workspaceId: string, path: string, doc: LoroDoc) => void
  // The live-document seam the routes read and write through, handed down
  // from document.ts.
  serverDeps: ServerDeps
}

/**
 * Runs the update, answering an engine abort as `document_engine_trap` — the
 * code `/api/v1` answers it with. The operation has already dropped the doc it
 * poisoned, so the caller is told what failed rather than the catch-all's
 * anonymous 500, and the next request is served.
 */
async function answeringEngineTrap(
  c: Context,
  run: () => Promise<LoroDoc>,
): Promise<LoroDoc | Response> {
  try {
    return await run()
  } catch (err) {
    if (!(err instanceof DocumentEngineTrapError)) throw err
    return c.json(errorBody('document_engine_trap', err.message), 500)
  }
}

// GET /api/w/:workspaceId/document/*/snapshot
// POST /api/w/:workspaceId/document/*/update
//
// Translation-only adapters (ADR-0018): the reads go through the
// LiveDocuments seam, and the update path — lock bracket, import, persist,
// evict-on-failure — lives in server-core's applyDocumentUpdate.
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

  onDocumentAction(
    app,
    'post',
    'update',
    async (c, workspaceId, path) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      // Bytes Loro cannot decode are the client's mistake, answered the way
      // the workspace-document route answers its own: checked before the
      // import, so a decode failure never escapes the handler as a 500.
      try {
        decodeImportBlobMeta(bytes, true)
      } catch {
        return c.json({ error: 'invalid_body', message: 'Malformed document update' }, 400)
      }
      const doc = await answeringEngineTrap(c, () =>
        applyDocumentUpdate(deps, { workspaceId, path, update: bytes }),
      )
      if (doc instanceof Response) return doc

      // No explicit broadcast: the save persisted through the workspace
      // record, whose funnel already fanned the persisted bytes to every
      // subscriber (including the sender, whose re-import is a CRDT no-op).

      // Signal that the document changed. The checkpoint lands once it goes
      // quiet, and the trigger broadcasts it from there — this call is
      // synchronous and cannot fail the update.
      options.triggerAutoVersion(workspaceId, path, doc)

      const response: UpdateDocumentResponse = { ok: true }
      return c.json(response)
    },
    limitBody(CONTENT_BODY_LIMIT_BYTES, 'Update'),
  )

  return app
}
