import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { sendViewportRequest, getClientCount } from './ws.js'
import { validationErrorBody, validateSessionId, validateSlug } from '../validators.js'

// requestId -> { resolve, reject }
// viewport does not return payload data, only an ACK, so it reuses the export-style pending map.
const pendingViewport = new Map<
  string,
  { resolve: () => void; reject: (err: Error) => void }
>()

// Receives WS viewport_response messages from ws.ts.
export function resolveViewportRequest(requestId: string): void {
  pendingViewport.get(requestId)?.resolve()
}

export interface CreateViewportRouterOptions {
  // Allow tests to shorten this. Default: 5 seconds, enough for viewport animation to settle.
  timeoutMs?: number
}

export function createViewportRouter(options: CreateViewportRouterOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000
  const app = new Hono()

  // POST /api/canvas/:sessionId/:slug/viewport
  app.post('/api/canvas/:sessionId/:slug/viewport', async (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }

    // The body is optional. Forward all viewport parameters (mode / elementIds /
    // padding / animate / scrollX / scrollY / zoom) to the browser, which applies defaults.
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>)

    // Fast-fail with 503 if no WS client is connected.
    if (getClientCount(sessionId, slug) === 0) {
      return c.json(
        {
          error: 'no_client',
          message:
            'No browser client is connected to this canvas. Open the canvas in a browser and retry.',
          hint: 'Call canvas_open first to open the canvas in a browser, then run viewport_set.',
        },
        503,
      )
    }

    const requestId = nanoid()

    try {
      await new Promise<void>((resolve, reject) => {
        pendingViewport.set(requestId, { resolve, reject })
        sendViewportRequest(sessionId, slug, requestId, body)

        setTimeout(() => {
          if (pendingViewport.has(requestId)) {
            pendingViewport.delete(requestId)
            reject(new Error('timeout'))
          }
        }, timeoutMs)
      }).finally(() => {
        pendingViewport.delete(requestId)
      })

      return c.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'timeout') {
        return c.json(
          {
            error: 'timeout',
            message: `Viewport update timed out after ${Math.round(timeoutMs / 1000)}s. The browser client did not acknowledge.`,
          },
          504,
        )
      }
      return c.json({ error: 'internal', message }, 500)
    }
  })

  return app
}
