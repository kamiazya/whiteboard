import { viewportRequestParamsSchema } from '@kamiazya/whiteboard-daemon-client/ws-messages'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type {
  ViewportErrorBody,
  ViewportResponse,
} from '../../shared/api-contracts/document-runtime.js'
import { onDocumentAction } from './document/path-route.js'
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

  onDocumentAction(app, 'post', 'viewport', async (c, workspaceId, path) => {
    // The body is optional. What it may carry is exactly what the browser
    // reads off the frame (`viewportRequestParamsSchema`), and it is checked
    // HERE: the browser drops a frame it cannot parse, so an unchecked body
    // used to turn a caller's typo into a 504.
    const body = await c.req.json<unknown>().catch(() => ({}))
    const params = viewportRequestParamsSchema.safeParse(body)
    if (!params.success) {
      const invalid: ViewportErrorBody = {
        error: 'invalid_request',
        message: `Invalid viewport request: ${params.error.issues
          .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
          .join('; ')}`,
      }
      return c.json(invalid, 400)
    }

    // Fast-fail with 503 if no WS client is connected.
    if (getClientCount(workspaceId, path) === 0) {
      const noClient: ViewportErrorBody = {
        error: 'no_client',
        message:
          'No browser client is connected to this canvas. Open the canvas in a browser and retry.',
        // Says what to do, and names no tool: an error meant to unblock a
        // caller is the worst place to send it after one that may not exist.
        hint: 'Open the canvas in a browser first — the whiteboard viewport tools act on a connected client — then retry.',
      }
      return c.json(noClient, 503)
    }

    const requestId = nanoid()

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        pendingViewport.set(requestId, { resolve, reject })
        sendViewportRequest(workspaceId, path, requestId, params.data)

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
