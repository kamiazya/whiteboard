import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { LoroDoc } from 'loro-crdt'
import type {
  CanvasExistsResponse,
  UpdateCanvasResponse,
} from '../../../shared/api-contracts/canvas.js'
import { getLogger } from '../../log.js'
import { canvasExists, saveCanvas } from '../../store/canvas-store.js'
import { evictDoc, getDoc } from '../../store/doc-cache.js'
import type { VersionEntry } from '../../store/version-store.js'
import { validateSlug, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { getBroadcastFn } from './shared.js'

// A Loro update embeds any attachment-affecting deltas since the client's
// last sync, so it can approach the file-upload ceiling in the worst case.
// Match files.ts's MAX_FILE_UPLOAD_BYTES rather than inventing a separate
// number.
const LIVE_DOC_UPDATE_LIMIT_BYTES = 16 * 1024 * 1024

export interface LiveDocRouterOptions {
  triggerAutoVersion: (
    workspaceId: string,
    slug: string,
    doc: LoroDoc,
  ) => Promise<VersionEntry | null>
}

// GET /api/canvas/:workspaceId/:slug/snapshot
// GET /api/canvas/:workspaceId/:slug/exists
// POST /api/canvas/:workspaceId/:slug/update
export function createLiveDocRouter(options: LiveDocRouterOptions) {
  const app = new Hono()

  app.get('/api/canvas/:workspaceId/:slug/exists', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const response: CanvasExistsResponse = { exists: await canvasExists(workspaceId, slug) }
    return c.json(response)
  })

  app.get('/api/canvas/:workspaceId/:slug/snapshot', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const doc = await getDoc(workspaceId, slug)
    const snapshot = doc.export({ mode: 'snapshot' }) as Uint8Array<ArrayBuffer>
    return c.body(snapshot, 200, {
      'Content-Type': 'application/octet-stream',
    })
  })

  app.post(
    '/api/canvas/:workspaceId/:slug/update',
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
    async (c) => {
      const { workspaceId, slug } = c.req.param()
      try {
        validateWorkspaceId(workspaceId)
        validateSlug(slug)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json(body, 400)
        throw err
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer())

      const doc = await getDoc(workspaceId, slug)
      doc.import(bytes)
      try {
        await saveCanvas(workspaceId, slug, doc, { overwrite: true })
      } catch (err) {
        // doc.import() above already mutated the cached doc, so a failed save
        // would otherwise leave the cache ahead of durable state. Evict it so
        // the next read reloads the last successfully persisted snapshot.
        evictDoc(workspaceId, slug)
        throw err
      }

      // Broadcast to all WS clients because the originating WS context is unknown on HTTP requests.
      getBroadcastFn()(workspaceId, slug, bytes)

      // Trigger auto-versioning. The throttle is built in, so below-threshold calls return null.
      // Even if saving the version fails, keep this API at 200 because the update itself is the priority.
      options
        .triggerAutoVersion(workspaceId, slug, doc)
        .then(async (entry) => {
          if (!entry) return
          const { sendVersionCreated } = await import('../ws.js')
          sendVersionCreated(workspaceId, slug, entry)
        })
        .catch((err: unknown) => {
          getLogger('canvas').error({ err: err as Error }, 'auto-version trigger failed')
        })

      const response: UpdateCanvasResponse = { ok: true }
      return c.json(response)
    },
  )

  return app
}
