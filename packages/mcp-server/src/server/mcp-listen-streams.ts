import type { Context, MiddlewareHandler } from 'hono'
import { createContentSlots } from './content-slots.js'

/**
 * How many `subscriptions/listen` streams server mode's `/mcp` holds open for
 * one user, and in all — the sync stream caps' numbers, for the same reason:
 * a stream carries no call and stays open for as long as its client likes,
 * each keeping a whole MCP server alive, so a caller opening them in a loop
 * is stopped long before the keeper's memory is. A client keeps one per
 * connection, so a person running a few agents stays far under the per-user
 * cap. The local daemon has one person and applies neither.
 */
export const MCP_LISTEN_STREAM_CAPS = { perUser: 16, total: 1024 } as const

interface ListenStreamCapOptions {
  readonly caps: { readonly perUser: number; readonly total: number }
  /** Whose request this is; null for a grant naming no user, all of which count as one. */
  readonly userOf: (c: Context) => Promise<string | null>
  /** Told of each refusal, so the composition can log it with its own logger. */
  readonly refused: (userId: string | null, cap: 'per_user' | 'total') => void
}

/** Whether this request opens a listen stream. The SDK refuses one whose header and body disagree. */
export function isListenRequest(c: Context): boolean {
  return (
    c.req.method.toUpperCase() === 'POST' && c.req.header('mcp-method') === 'subscriptions/listen'
  )
}

/**
 * Holds `/mcp`'s listen streams to `caps`: a place is taken before the
 * request is served, ridden by the stream it opens, and given back when that
 * stream ends, errors or is cancelled — or at once, when the answer is not a
 * stream. Past either cap the request is refused with 429 in JSON-RPC's shape
 * before any server is built for it.
 */
export function capListenStreams(options: ListenStreamCapOptions): MiddlewareHandler {
  const places = createContentSlots(options.caps)
  return async (c, next) => {
    if (!isListenRequest(c)) return next()
    const userId = await options.userOf(c)
    const place = places.take(userId)
    if (typeof place !== 'function') {
      options.refused(userId, place)
      const message =
        place === 'per_user'
          ? 'this user already holds as many listen streams as the keeper allows'
          : 'the keeper already holds as many listen streams as it allows'
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, 429)
    }
    let riding = false
    try {
      await next()
      const body = c.res.body
      if (body !== null && isEventStream(c.res)) {
        c.res = new Response(releasedWhenDone(body, place), c.res)
        riding = true
      }
    } finally {
      if (!riding) place()
    }
  }
}

export function isEventStream(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true
}

/** `body`, calling `release` once it has been read to its end, has failed, or was cancelled. */
export function releasedWhenDone(
  body: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            release()
            controller.close()
            return
          }
          controller.enqueue(value)
        } catch (error) {
          release()
          controller.error(error)
        }
      },
      async cancel(reason) {
        release()
        await reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
