import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { LoroDoc } from 'loro-crdt'
import type {
  CanvasExistsResponse,
  UpdateCanvasResponse,
} from '../../../shared/api-contracts/canvas.js'
import { getLogger } from '../../log.js'
import { evictDoc, getDoc } from '../../store/doc-cache.js'
import { documentExists, saveDocument } from '../../store/document-store.js'
import type { VersionEntry } from '../../store/version-store.js'
import { withWorkspaceWriteLock } from '../../store/workspace-lock.js'
import { getBroadcastFn } from './_shared.js'
import { onCanvasAction } from './path-route.js'

// A Loro update embeds any attachment-affecting deltas since the client's
// last sync, so it can approach the file-upload ceiling in the worst case.
// Match files.ts's MAX_FILE_UPLOAD_BYTES rather than inventing a separate
// number.
const LIVE_DOC_UPDATE_LIMIT_BYTES = 16 * 1024 * 1024

export interface LiveDocRouterOptions {
  triggerAutoVersion: (
    workspaceId: string,
    path: string,
    doc: LoroDoc,
  ) => Promise<VersionEntry | null>
}

// GET /api/w/:workspaceId/canvas/*/snapshot
// GET /api/w/:workspaceId/canvas/*/exists
// POST /api/w/:workspaceId/canvas/*/update
export function createLiveDocRouter(options: LiveDocRouterOptions) {
  const app = new Hono()

  onCanvasAction(app, 'get', 'exists', async (c, workspaceId, path) => {
    const response: CanvasExistsResponse = { exists: await documentExists(workspaceId, path) }
    return c.json(response)
  })

  onCanvasAction(app, 'get', 'snapshot', async (c, workspaceId, path) => {
    // getDoc()'s lazy-create would otherwise silently hand back an empty
    // doc for a canvas that does not exist — indistinguishable from a
    // never-created OR just-deleted canvas. Same problem-details { title }
    // shape as DELETE, deliberately not thumbnails/restore's { error,
    // message }: the client parses problem-details for both routes.
    if (!(await documentExists(workspaceId, path))) {
      return c.json({ title: `Canvas "${path}" not found` }, 404)
    }
    const doc = await getDoc(workspaceId, path)
    const snapshot = doc.export({ mode: 'snapshot' }) as Uint8Array<ArrayBuffer>
    return c.body(snapshot, 200, {
      'Content-Type': 'application/octet-stream',
    })
  })

  onCanvasAction(
    app,
    'post',
    'update',
    async (c, workspaceId, path) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())

      // Resolve the doc AND persist it inside one lock hold. getDoc() alone is
      // unlocked, so a rename that runs its whole lock-protected section
      // between an unlocked read here and saveDocument()'s own later lock
      // acquisition would find no row left at the old path (renameDocumentPath
      // moved it) and silently insert a brand-new phantom canvas back at
      // that path instead of erroring or landing on the renamed one. Sharing
      // the workspace write lock across the read and the write closes that
      // window: the two operations settle into one definite order instead of
      // interleaving through a stale read.
      const doc = await withWorkspaceWriteLock(workspaceId, async () => {
        const resolved = await getDoc(workspaceId, path)
        resolved.import(bytes)
        try {
          await saveDocument(workspaceId, path, resolved, { overwrite: true })
        } catch (err) {
          // doc.import() above already mutated the cached doc, so a failed save
          // would otherwise leave the cache ahead of durable state. Evict it so
          // the next read reloads the last successfully persisted snapshot.
          evictDoc(workspaceId, path)
          throw err
        }
        return resolved
      })

      // Broadcast to all WS clients because the originating WS context is unknown on HTTP requests.
      getBroadcastFn()(workspaceId, path, bytes)

      // Trigger auto-versioning. The throttle is built in, so below-threshold calls return null.
      // Even if saving the version fails, keep this API at 200 because the update itself is the priority.
      options
        .triggerAutoVersion(workspaceId, path, doc)
        .then(async (entry) => {
          if (!entry) return
          const { sendVersionCreated } = await import('../ws.js')
          sendVersionCreated(workspaceId, path, entry)
        })
        .catch((err: unknown) => {
          getLogger('canvas').error({ err: err as Error }, 'auto-version trigger failed')
        })

      const response: UpdateCanvasResponse = { ok: true }
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
