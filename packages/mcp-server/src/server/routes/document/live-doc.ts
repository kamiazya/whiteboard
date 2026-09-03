import { applyDocumentUpdate, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { LoroDoc } from 'loro-crdt'
import { getDefaultServerDeps } from '../../../di/default-server-deps.js'
import type {
  DocumentExistsResponse,
  UpdateDocumentResponse,
} from '../../../shared/api-contracts/document.js'
import { onDocumentAction } from './path-route.js'

// A Loro update embeds any attachment-affecting deltas since the client's
// last sync, so it can approach the file-upload ceiling in the worst case.
// Match files.ts's MAX_FILE_UPLOAD_BYTES rather than inventing a separate
// number.
const LIVE_DOC_UPDATE_LIMIT_BYTES = 16 * 1024 * 1024

export interface LiveDocRouterOptions {
  triggerAutoVersion: (workspaceId: string, path: string, doc: LoroDoc) => void
  // The live-document seam the routes read and write through. Production
  // wires this from document.ts; a router built without it falls back to the
  // same wiring via getDefaultServerDeps.
  serverDeps?: ServerDeps
}

// GET /api/w/:workspaceId/document/*/snapshot
// GET /api/w/:workspaceId/document/*/exists
// POST /api/w/:workspaceId/document/*/update
//
// Translation-only adapters (ADR-0018): the reads go through the
// LiveDocuments seam, and the update path — lock bracket, import, persist,
// evict-on-failure — lives in server-core's applyDocumentUpdate.
export function createLiveDocRouter(options: LiveDocRouterOptions) {
  const app = new Hono()
  const depsOf = async (): Promise<ServerDeps> =>
    options.serverDeps ?? (await getDefaultServerDeps())

  onDocumentAction(app, 'get', 'exists', async (c, workspaceId, path) => {
    const deps = await depsOf()
    const response: DocumentExistsResponse = {
      exists: await deps.liveDocuments.exists(workspaceId, path),
    }
    return c.json(response)
  })

  onDocumentAction(app, 'get', 'snapshot', async (c, workspaceId, path) => {
    const deps = await depsOf()
    // get()'s lazy-create would otherwise silently hand back an empty
    // doc for a canvas that does not exist — indistinguishable from a
    // never-created OR just-deleted canvas. Same problem-details { title }
    // shape as DELETE, deliberately not thumbnails/restore's { error,
    // message }: the client parses problem-details for both routes.
    if (!(await deps.liveDocuments.exists(workspaceId, path))) {
      return c.json({ title: `Canvas "${path}" not found` }, 404)
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
      const deps = await depsOf()
      const doc = await applyDocumentUpdate(deps, { workspaceId, path, update: bytes })

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
    bodyLimit({
      maxSize: LIVE_DOC_UPDATE_LIMIT_BYTES,
      onError: (c) =>
        c.json(
          {
            error: 'payload_too_large',
            message: `Update exceeds ${LIVE_DOC_UPDATE_LIMIT_BYTES} bytes limit.`,
          },
          413,
        ),
    }),
  )

  return app
}
