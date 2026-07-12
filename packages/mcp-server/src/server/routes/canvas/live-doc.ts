import { Hono } from 'hono'
import type { LoroDoc } from 'loro-crdt'
import type { UpdateCanvasResponse } from '../../../shared/api-contracts/canvas.js'
import { getLogger } from '../../log.js'
import { saveCanvas } from '../../store/canvas-store.js'
import { getDoc } from '../../store/doc-cache.js'
import type { VersionEntry } from '../../store/version-store.js'
import { validateSlug, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { getBroadcastFn } from './shared.js'

export interface LiveDocRouterOptions {
  triggerAutoVersion: (
    workspaceId: string,
    slug: string,
    doc: LoroDoc,
  ) => Promise<VersionEntry | null>
}

// GET /api/canvas/:workspaceId/:slug/snapshot
// POST /api/canvas/:workspaceId/:slug/update
export function createLiveDocRouter(options: LiveDocRouterOptions) {
  const app = new Hono()

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

  app.post('/api/canvas/:workspaceId/:slug/update', async (c) => {
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
    await saveCanvas(workspaceId, slug, doc, { overwrite: true })

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
  })

  return app
}
