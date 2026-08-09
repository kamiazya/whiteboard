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
import type {
  SyncMessageEvent,
  SyncReadyEvent,
  SyncUpdateEvent,
} from '../../shared/sync-sse-contract.js'
import { clientTextMessageSchema } from '../../shared/ws-messages.js'
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

export const syncClientMessageRequestSchema = z
  .object({
    streamId: z.string().min(1),
    doc: z.string().min(1),
    // Reuses the WebSocket client-message union so both transports validate
    // against one declaration instead of drifting apart.
    message: clientTextMessageSchema,
  })
  .strict()

export type SyncClientMessageRequest = z.infer<typeof syncClientMessageRequestSchema>

// Injected by ws.ts, which owns the viewport cache and the pending-request
// resolver. ws.ts already imports this module for the broadcast fan-out, so
// importing it back would close a cycle — this mirrors the setBroadcastFn /
// setResolveViewportFn idiom already used between these modules.
let getCachedViewportRequest: (docKey: string) => string | undefined = () => undefined
let resolveViewportRequest: (requestId: string) => void = () => {}

export function setSyncSseHooks(hooks: {
  getCachedViewportRequest: (docKey: string) => string | undefined
  resolveViewportRequest: (requestId: string) => void
}): void {
  getCachedViewportRequest = hooks.getCachedViewportRequest
  resolveViewportRequest = hooks.resolveViewportRequest
}

/**
 * `ready` says the stream has signalled `client_ready` for that document. A
 * viewport request is withheld until then and replayed from cache on ready,
 * matching the WebSocket path — a pre-ready client cannot apply a viewport,
 * and sending it both now and on replay would deliver it twice.
 *
 * It is a field on the subscription rather than a second set keyed by the same
 * document, so readiness cannot outlive the subscription it describes:
 * unsubscribing is one delete, with nothing left to forget to clear.
 */
interface SyncStreamDoc {
  ready: boolean
}

interface SyncStream {
  docs: Map<string, SyncStreamDoc>
  send: (event: string, data: string) => void
}

const streams = new Map<string, SyncStream>()

export function docKey(workspaceId: string, slug: string): string {
  return `${workspaceId}/${slug}`
}

function toBase64(bytes: Uint8Array): string {
  // Node-only file (mcp-server builds with `platform: 'node'`), so this takes
  // the native conversion rather than building a string one byte at a time.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
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

/**
 * Fan a server text message (version_created, head_changed, …) out to SSE
 * subscribers, wrapped with the document it belongs to.
 *
 * A WebSocket is per-canvas, so its text frames need no addressing. One SSE
 * stream serves many canvases, so an unaddressed frame would be applied to
 * whichever canvas happened to be listening — a head_changed for one canvas
 * landing on another.
 */
export function sseBroadcastText(workspaceId: string, slug: string, raw: string): void {
  const key = docKey(workspaceId, slug)
  const payload: SyncMessageEvent = { doc: key, raw }
  const frame = JSON.stringify(payload)
  for (const stream of streams.values()) {
    if (!stream.docs.has(key)) continue
    stream.send('message', frame)
  }
}

/** Like sseBroadcastText, but only to streams that have signalled client_ready. */
export function sseBroadcastTextToReady(workspaceId: string, slug: string, raw: string): void {
  const key = docKey(workspaceId, slug)
  const payload: SyncMessageEvent = { doc: key, raw }
  const frame = JSON.stringify(payload)
  for (const stream of streams.values()) {
    if (!stream.docs.get(key)?.ready) continue
    stream.send('message', frame)
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
    // The id is minted here and never accepted from the caller. A client-chosen
    // key into a server-side registry lets one client name another's stream —
    // displacing it on open, or adding and removing that client's
    // subscriptions behind its back. Delivered as the first frame, so holding
    // it is what proves the stream is yours.
    const streamId = globalThis.crypto.randomUUID()

    return streamSSE(c, async (stream) => {
      const entry: SyncStream = {
        docs: new Map(),
        send: (event, data) => {
          void stream.writeSSE({ event, data })
        },
      }
      streams.set(streamId, entry)
      const ready: SyncReadyEvent = { streamId }
      await stream.writeSSE({ event: 'ready', data: JSON.stringify(ready) })
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

    for (const key of parsed.data.subscribe ?? []) {
      if (!stream.docs.has(key)) stream.docs.set(key, { ready: false })
    }
    // One delete takes the readiness with it.
    for (const key of parsed.data.unsubscribe ?? []) stream.docs.delete(key)
    const docs = [...stream.docs.keys()].sort()
    // A stream that reaches zero documents is the state worth seeing: the
    // client stops reconnecting there, so a gap between "the last tab
    // unsubscribed" and "a tab subscribed again" is a window with no stream
    // at all. Without this the two are indistinguishable from the outside.
    log.info(
      {
        streamId: parsed.data.streamId,
        subscribed: parsed.data.subscribe ?? [],
        unsubscribed: parsed.data.unsubscribe ?? [],
        docCount: docs.length,
      },
      'sync subscriptions changed',
    )
    return c.json({ ok: true, docs })
  })

  // The client->server half of the sync protocol. A WebSocket carries these as
  // text frames; an SSE client has no upstream channel of its own, so they
  // arrive here instead. The payload reuses clientTextMessageSchema so both
  // transports validate against the same declaration rather than drifting.
  app.post('/api/sync/message', async (c) => {
    const parsed = syncClientMessageRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)

    const stream = streams.get(parsed.data.streamId)
    if (!stream) return c.json({ error: 'unknown_stream' }, 404)

    const { doc, message } = parsed.data
    if (message.type === 'client_ready') {
      // Upsert rather than require an existing subscription: subscribe and
      // client_ready are separate POSTs with no ordering guarantee between
      // them, and dropping readiness that arrived first would withhold the
      // viewport request for good. Declaring readiness is a statement of
      // interest in the document either way.
      const entry = stream.docs.get(doc) ?? { ready: false }
      entry.ready = true
      stream.docs.set(doc, entry)
      // Replay the latest viewport request so a stream that connected after
      // the request was issued still inherits the same fit/scroll/zoom intent.
      const cached = getCachedViewportRequest(doc)
      if (cached !== undefined) stream.send('message', JSON.stringify({ doc, raw: cached }))
      return c.json({ ok: true })
    }
    if (message.type === 'viewport_response') {
      resolveViewportRequest(message.requestId)
      return c.json({ ok: true })
    }
    // `export_response` is inert on the WebSocket path too — the daemon stopped
    // sending export_request once export became headless — and `ws_trace`
    // carries a trace context that only the WebSocket's binary-frame pairing
    // can consume. Accepted and ignored, so a client need not special-case them.
    return c.json({ ok: true })
  })

  return app
}
