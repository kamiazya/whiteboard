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

import {
  WORKSPACE_DOC_KEY_PREFIX,
  workspaceDocKey,
  workspaceIdOfDocKey,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import type {
  SyncMessageEvent,
  SyncReadyEvent,
  SyncUpdateEvent,
} from '@kamiazya/whiteboard-daemon-client/sync-sse-contract'
import { clientTextMessageSchema } from '@kamiazya/whiteboard-daemon-client/ws-messages'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { getLogger } from '../log.js'
import type { WorkspaceAdmit } from '../security/membership-gate.js'
import { membershipRefusal } from '../security/workspace-access.js'

const log = getLogger('sync-sse')

export const syncSubscribeRequestSchema = z
  .object({
    streamId: z.string().min(1),
    // Doc keys are `${workspaceId}/${path}`, matching the WS connection registry.
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

/**
 * The workspaces a stream here subscribed to at workspace granularity — the
 * record the workspace tail follows. A per-document key carries text only.
 */
export function sseSubscribedWorkspaceIds(): string[] {
  const ids = new Set<string>()
  for (const stream of streams.values()) {
    for (const key of stream.docs.keys()) {
      if (key.startsWith(WORKSPACE_DOC_KEY_PREFIX))
        ids.add(key.slice(WORKSPACE_DOC_KEY_PREFIX.length))
    }
  }
  return [...ids]
}

/**
 * A request for a stream this instance does not hold. Answering 200 would
 * leave the caller believing it is subscribed and waiting forever. It is a
 * race with a reconnect (a stale id) — or, with several instances, the stream
 * is on another one, which is what a load balancer without sticky sessions
 * does to a browser; that is a deployment fault, so it is said out loud.
 */
function unknownStream(c: Context, streamId: string): Response {
  log.warning(
    { streamId },
    'sync request for a stream this instance does not hold — a stale stream, or a load balancer without sticky sessions',
  )
  return c.json({ error: 'unknown_stream' }, 404)
}

export function docKey(workspaceId: string, path: string): string {
  return `${workspaceId}/${path}`
}

function toBase64(bytes: Uint8Array): string {
  // Node-only file (mcp-server builds with `platform: 'node'`), so this takes
  // the native conversion rather than building a string one byte at a time.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/**
 * Fan a WORKSPACE-DOCUMENT update out to every stream subscribed at
 * workspace granularity (`workspace:<id>` keys). The only binary fan-out:
 * the per-document one is retired — a per-document subscriber handed
 * workspace-document bytes (or the reverse) would be importing a stranger's
 * history, so per-document keys carry text events only.
 */
export function sseBroadcastWorkspaceUpdate(workspaceId: string, update: Uint8Array): void {
  const key = workspaceDocKey(workspaceId)
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
 * stream serves many documents, so an unaddressed frame would be applied to
 * whichever canvas happened to be listening — a head_changed for one canvas
 * landing on another.
 */
export function sseBroadcastText(workspaceId: string, path: string, raw: string): void {
  const key = docKey(workspaceId, path)
  const payload: SyncMessageEvent = { doc: key, raw }
  const frame = JSON.stringify(payload)
  for (const stream of streams.values()) {
    if (!stream.docs.has(key)) continue
    stream.send('message', frame)
  }
}

/** Like sseBroadcastText, but only to streams that have signalled client_ready. */
export function sseBroadcastTextToReady(workspaceId: string, path: string, raw: string): void {
  const key = docKey(workspaceId, path)
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

// This transport's own funnel subscription, installed by its own entry
// point (stream-open) — an SSE-only audience must hear persisted updates
// whether or not a websocket ever connected (ws.ts installs its own; see
// installWsUpdateFanout). Subscribed through the WorkspaceDocuments seam
// (ADR-0018) via the same wiring production resolves; memoized as a promise
// so concurrent first opens install once, and a failed resolve retries on
// the next open instead of poisoning the flag.
let sseFanoutInstall: Promise<void> | null = null
function ensureSseUpdateFanout(): Promise<void> {
  sseFanoutInstall ??= (async () => {
    // Dynamic for the same value-cycle reason ws.ts gives: the di wiring's
    // import chain reaches back into the routes through canvas-client-notifier.
    const { getDefaultServerDeps } = await import('../../di/default-server-deps.js')
    const deps = await getDefaultServerDeps()
    deps.workspaceDocuments.onUpdated((workspaceId, update) => {
      sseBroadcastWorkspaceUpdate(workspaceId, update)
    })
  })().catch((err: unknown) => {
    sseFanoutInstall = null
    throw err
  })
  return sseFanoutInstall
}

export interface SyncSseRouterOptions {
  /** S8 slice 2: the membership gate. Absent means no gate at all
   *  (server-mode, and any composition that has not wired members). */
  admit?: WorkspaceAdmit
}

/**
 * The membership gate for the SSE transport (S8 slice 2): decides ONCE per
 * distinct workspace among `keys`, refusing the whole request on the FIRST
 * non-admitted one — before any stream lookup, so a refused caller learns
 * nothing about stream ids. A malformed key is left to the route's own
 * validation rather than refused here.
 */
async function firstMembershipRefusal(
  c: Context,
  admit: WorkspaceAdmit | undefined,
  keys: readonly string[],
): Promise<ReturnType<typeof membershipRefusal> | null> {
  if (admit === undefined) return null
  const decidedAdmitted = new Set<string>()
  for (const key of keys) {
    const workspaceId = workspaceIdOfDocKey(key)
    if (workspaceId === null || decidedAdmitted.has(workspaceId)) continue
    const access = await admit(c, workspaceId)
    if (access !== 'admitted') {
      log.warning({ workspaceId, reason: access }, 'sync sse refused')
      return membershipRefusal(access)
    }
    decidedAdmitted.add(workspaceId)
  }
  return null
}

/**
 * Apply one subscribe/unsubscribe batch to a stream's document set, and
 * answer with what it now holds, sorted.
 *
 * A subscribe never resets readiness a `client_ready` already recorded, and
 * one delete takes the readiness with it.
 */
function applySubscriptions(
  docs: Map<string, { ready: boolean }>,
  subscribe: readonly string[],
  unsubscribe: readonly string[],
): string[] {
  for (const key of subscribe) if (!docs.has(key)) docs.set(key, { ready: false })
  for (const key of unsubscribe) docs.delete(key)
  return [...docs.keys()].sort()
}

export function createSyncSseRouter(options: SyncSseRouterOptions = {}) {
  const app = new Hono()

  app.get('/api/sync/stream', async (c) => {
    await ensureSseUpdateFanout()
    // The id is minted here and never accepted from the caller. A client-chosen
    // key into a server-side registry lets one client name another's stream —
    // displacing it on open, or adding and removing that client's
    // subscriptions behind its back. Delivered as the first frame, so holding
    // it is what proves the stream is yours.
    const streamId = globalThis.crypto.randomUUID()
    // nginx otherwise holds a proxied stream in a buffer, delaying every update.
    c.header('X-Accel-Buffering', 'no')

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

    const subscribe = parsed.data.subscribe ?? []
    const unsubscribe = parsed.data.unsubscribe ?? []

    const refusal = await firstMembershipRefusal(c, options.admit, subscribe)
    if (refusal) return c.json(refusal, 403)

    const stream = streams.get(parsed.data.streamId)
    // A subscribe for a stream that is not open is a client bug (a race with
    // reconnect, a stale streamId). Answering 200 would leave the caller
    // believing it is subscribed and waiting forever for updates.
    if (!stream) return unknownStream(c, parsed.data.streamId)

    const docs = applySubscriptions(stream.docs, subscribe, unsubscribe)
    // A stream that reaches zero documents is the state worth seeing: the
    // client stops reconnecting there, so a gap between "the last tab
    // unsubscribed" and "a tab subscribed again" is a window with no stream
    // at all. Without this the two are indistinguishable from the outside.
    log.info(
      {
        streamId: parsed.data.streamId,
        subscribed: subscribe,
        unsubscribed: unsubscribe,
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

    const refusal = await firstMembershipRefusal(c, options.admit, [parsed.data.doc])
    if (refusal) return c.json(refusal, 403)

    const stream = streams.get(parsed.data.streamId)
    if (!stream) return unknownStream(c, parsed.data.streamId)

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
