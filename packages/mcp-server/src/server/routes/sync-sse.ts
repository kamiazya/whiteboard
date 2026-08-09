// SSE sync transport: the downstream half of the sync path for a caller that
// cannot open a WebSocket to this daemon.
//
// A page served over https cannot open a `ws://` socket to loopback — mixed
// content blocks it before the upgrade is even attempted — while a plain
// `http://` fetch to loopback stays allowed. The hosted web app therefore has
// no WebSocket route to a local daemon at all, and rides SSE downstream with
// ordinary POSTs upstream instead.
//
// One stream serves MANY documents. Browsers cap concurrent HTTP/1.1
// connections per origin at six, and a stream per open canvas tab would starve
// the daemon's own API; the client keeps a single stream (shared across tabs)
// and adjusts its subscriptions over POST, because SSE itself is one-way.
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { getLogger } from '../log.js'

const log = getLogger('sync-sse')

export const syncSubscribeRequestSchema = z
  .object({
    streamId: z.string().min(1),
    // Doc keys are `${workspaceId}/${slug}`, matching the WS connection registry.
    subscribe: z.array(z.string().min(1)).optional(),
    unsubscribe: z.array(z.string().min(1)).optional(),
  })
  .strict()

export type SyncSubscribeRequest = z.infer<typeof syncSubscribeRequestSchema>

export const syncUpdateEventSchema = z
  .object({
    doc: z.string().min(1),
    // SSE frames are text, so Loro update bytes travel base64-encoded. Only
    // incremental updates go through here — the initial snapshot is served as
    // binary by GET /api/canvas/:workspaceId/:slug/snapshot, so the largest
    // payload never pays the base64 inflation.
    update: z.string(),
  })
  .strict()

export type SyncUpdateEvent = z.infer<typeof syncUpdateEventSchema>

interface SyncStream {
  docs: Set<string>
  send: (event: string, data: string) => void
}

const streams = new Map<string, SyncStream>()

export function docKey(workspaceId: string, slug: string): string {
  return `${workspaceId}/${slug}`
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Fan a Loro update out to every SSE stream subscribed to that document.
 * Called alongside the WebSocket fan-out so a change reaches both transports
 * regardless of which one produced it — an MCP tool edit and a WS peer edit
 * are indistinguishable to a subscriber.
 */
export function sseBroadcastUpdate(workspaceId: string, slug: string, update: Uint8Array): void {
  const key = docKey(workspaceId, slug)
  const payload: SyncUpdateEvent = { doc: key, update: toBase64(update) }
  const frame = JSON.stringify(payload)
  for (const stream of streams.values()) {
    if (!stream.docs.has(key)) continue
    stream.send('update', frame)
  }
}

/** Fan a server text message (version_created, head_changed, …) out to SSE subscribers. */
export function sseBroadcastText(workspaceId: string, slug: string, raw: string): void {
  const key = docKey(workspaceId, slug)
  for (const stream of streams.values()) {
    if (!stream.docs.has(key)) continue
    stream.send('message', raw)
  }
}

// Test-only: the module-level registry outlives a single app instance, so a
// test that opens a stream would otherwise leak a subscriber into the next one.
export function resetSyncStreamsForTests(): void {
  streams.clear()
}

export function createSyncSseRouter() {
  const app = new Hono()

  app.get('/api/sync/stream', (c) => {
    const streamId = c.req.query('streamId')
    if (!streamId) return c.json({ error: 'streamId required' }, 400)

    return streamSSE(c, async (stream) => {
      const entry: SyncStream = {
        docs: new Set(),
        send: (event, data) => {
          void stream.writeSSE({ event, data })
        },
      }
      // Last writer wins: a reconnect reusing its streamId replaces the dead
      // entry rather than accumulating a second one that can never be reached.
      streams.set(streamId, entry)
      log.info({ streamId }, 'sync stream opened')

      stream.onAbort(() => {
        streams.delete(streamId)
        log.info({ streamId }, 'sync stream closed')
      })

      // Hold the stream open. streamSSE resolves the callback -> closes the
      // response, so the connection lives exactly as long as this promise.
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve)
      })
    })
  })

  app.post('/api/sync/subscribe', async (c) => {
    const parsed = syncSubscribeRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)

    const stream = streams.get(parsed.data.streamId)
    // A subscribe for a stream that is not open is a client bug (a race with
    // reconnect, a stale streamId). Answering 200 would leave the caller
    // believing it is subscribed and waiting forever for updates.
    if (!stream) return c.json({ error: 'unknown_stream' }, 404)

    for (const key of parsed.data.subscribe ?? []) stream.docs.add(key)
    for (const key of parsed.data.unsubscribe ?? []) stream.docs.delete(key)
    return c.json({ ok: true, docs: [...stream.docs].sort() })
  })

  return app
}
