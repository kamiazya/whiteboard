import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type {
  ViewportErrorBody,
  ViewportResponse,
} from '../../shared/api-contracts/canvas-runtime.js'
import { onCanvasAction } from './canvas/path-route.js'
import { getClientCount, sendViewportRequest } from './ws.js'

// requestId -> { resolve, reject }
// viewport does not return payload data, only an ACK, so it reuses the export-style pending map.
const pendingViewport = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()

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

  onCanvasAction(app, 'post', 'viewport', async (c, workspaceId, path) => {
    // The body is optional. Forward all viewport parameters (mode / elementIds /
    // padding / animate / scrollX / scrollY / zoom) to the browser, which applies defaults.
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>)

    // Fast-fail with 503 if no WS client is connected.
    if (getClientCount(workspaceId, path) === 0) {
      const noClient: ViewportErrorBody = {
        error: 'no_client',
        message:
          'No browser client is connected to this canvas. Open the canvas in a browser and retry.',
        hint: 'Call canvas_open first to open the canvas in a browser, then run viewport_set.',
      }
      return c.json(noClient, 503)
    }

    const requestId = nanoid()

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        pendingViewport.set(requestId, { resolve, reject })
        sendViewportRequest(workspaceId, path, requestId, body)

        timer = setTimeout(() => {
          if (pendingViewport.has(requestId)) {
            pendingViewport.delete(requestId)
            reject(new Error('timeout'))
          }
        }, timeoutMs)
      }).finally(() => {
        pendingViewport.delete(requestId)
        clearTimeout(timer)
      })

      const ok: ViewportResponse = { ok: true }
      return c.json(ok)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'timeout') {
        const timeoutBody: ViewportErrorBody = {
          error: 'timeout',
          message: `Viewport update timed out after ${Math.round(timeoutMs / 1000)}s. The browser client did not acknowledge.`,
        }
        return c.json(timeoutBody, 504)
      }
      const internalBody: ViewportErrorBody = { error: 'internal', message }
      return c.json(internalBody, 500)
    }
  })

  return app
}
