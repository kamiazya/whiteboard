// SSE sync transport: the downstream half of the sync path, with ordinary
// POSTs upstream. It is the only live transport a page has — the WebSocket
// is retired (ADR-0050 decision 1) — whether the page reaches a local daemon
// through the extension bridge or a server-mode keeper directly.
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
import {
  MAX_DOCS_PER_STREAM,
  type SyncReadyEvent,
  type SyncSubscribeResponse,
  syncClientMessageRequestSchema,
  syncSubscribeRequestSchema,
} from '@kamiazya/whiteboard-daemon-client/sync-sse-contract'
import { invalidRequestBody, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getLogger } from '../log.js'
import type { WorkspaceAdmit } from '../security/membership-gate.js'
import { membershipRefusal } from '../security/workspace-access.js'
import {
  docKey,
  registerSyncStream,
  type SyncStream,
  type SyncStreamDoc,
  sseBroadcastWorkspaceUpdate,
  syncStreamById,
  unregisterSyncStream,
} from '../sync-streams.js'
import { cachedViewportRequest } from '../viewport-requests.js'
import { resolveWorkspaceHandleToId } from '../workspace-handle.js'

const log = getLogger('sync-sse')

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

/**
 * A doc key with its workspace handle resolved to the id, which is what
 * every registry and broadcast here is keyed by. Total, as the resolver is:
 * a key naming no workspace comes back unchanged.
 */
async function canonicalDocKey(
  key: string,
  resolve: (handle: string) => Promise<string> = resolveWorkspaceHandleToId,
): Promise<string> {
  const handle = workspaceIdOfDocKey(key)
  if (handle === null) return key
  const workspaceId = await resolve(handle)
  if (workspaceId === handle) return key
  return key.startsWith(WORKSPACE_DOC_KEY_PREFIX)
    ? workspaceDocKey(workspaceId)
    : docKey(workspaceId, key.slice(handle.length + 1))
}

/**
 * Each key as the client wrote it, beside its canonical form. A handle is
 * resolved once however many keys name it, since each resolution reads the
 * workspace registry.
 */
async function canonicalKeys(keys: readonly string[]): Promise<Array<{ key: string; as: string }>> {
  const resolutions = new Map<string, Promise<string>>()
  const resolve = (handle: string) => {
    let resolution = resolutions.get(handle)
    if (resolution === undefined) {
      resolution = resolveWorkspaceHandleToId(handle)
      resolutions.set(handle, resolution)
    }
    return resolution
  }
  return Promise.all(keys.map(async (as) => ({ key: await canonicalDocKey(as, resolve), as })))
}

export interface SyncSseRouterOptions {
  /** The workspace-record seam whose updates this stream carries. */
  workspaceDocuments: Pick<ServerDeps['workspaceDocuments'], 'onUpdated'>
  /** The membership gate. Absent means no gate at all
   *  (server-mode, and any composition that has not wired members). */
  admit?: WorkspaceAdmit
  /** Whose stream this is, so losing access can end it. Absent: nobody's. */
  userOf?: (c: Context) => Promise<string | null>
}

/**
 * The membership gate for the SSE transport: decides ONCE per
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

function exceedsStreamCap(
  docs: Map<string, unknown>,
  subscribe: readonly string[],
  unsubscribe: readonly string[],
): boolean {
  const adding = subscribe.filter((key) => !docs.has(key) && !unsubscribe.includes(key))
  return docs.size + adding.length > MAX_DOCS_PER_STREAM
}

/**
 * Apply one subscribe/unsubscribe batch to a stream's document set, and
 * answer with what it now holds, sorted.
 *
 * A subscribe never resets readiness a `client_ready` already recorded, and
 * one delete takes the readiness with it.
 */
function applySubscriptions(
  docs: Map<string, SyncStreamDoc>,
  subscribe: ReadonlyArray<{ key: string; as: string }>,
  unsubscribe: readonly string[],
): string[] {
  for (const { key, as } of subscribe) if (!docs.has(as)) docs.set(as, { ready: false, key })
  for (const as of unsubscribe) docs.delete(as)
  return [...docs.keys()].sort()
}

function markReady(stream: SyncStream, doc: { key: string; as: string }): void {
  const entry = stream.docs.get(doc.as) ?? { ready: false, key: doc.key }
  entry.ready = true
  stream.docs.set(doc.as, entry)
  // Replay the latest viewport request so a stream that connected after
  // the request was issued still inherits the same fit/scroll/zoom intent.
  const cached = cachedViewportRequest(doc.key)
  if (cached !== undefined) stream.send('message', JSON.stringify({ doc: doc.as, raw: cached }))
}

async function handleSubscribe(c: Context, admit: WorkspaceAdmit | undefined) {
  const parsed = syncSubscribeRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json(invalidRequestBody(parsed.error), 400)

  // Resolved before the gate, so membership is decided for the workspace
  // a key actually reaches, whichever handle named it.
  const subscribe = await canonicalKeys(parsed.data.subscribe ?? [])
  // Dropped by the spelling it was subscribed under, so no resolution.
  const unsubscribe = parsed.data.unsubscribe ?? []

  const refusal = await firstMembershipRefusal(
    c,
    admit,
    subscribe.map(({ key }) => key),
  )
  if (refusal) return c.json(refusal, 403)

  const stream = syncStreamById(parsed.data.streamId)
  // A subscribe for a stream that is not open is a client bug (a race with
  // reconnect, a stale streamId). Answering 200 would leave the caller
  // believing it is subscribed and waiting forever for updates.
  if (!stream) return unknownStream(c, parsed.data.streamId)

  if (
    exceedsStreamCap(
      stream.docs,
      subscribe.map(({ as }) => as),
      unsubscribe,
    )
  ) {
    return c.json({ error: 'too_many_subscriptions' }, 400)
  }
  const docs = applySubscriptions(stream.docs, subscribe, unsubscribe)
  // A stream that reaches zero documents is the state worth seeing: the
  // client stops reconnecting there, so a gap between "the last tab
  // unsubscribed" and "a tab subscribed again" is a window with no stream
  // at all. Without this the two are indistinguishable from the outside.
  log.info(
    {
      streamId: parsed.data.streamId,
      subscribed: subscribe.map(({ as }) => as),
      unsubscribed: parsed.data.unsubscribe ?? [],
      docCount: docs.length,
    },
    'sync subscriptions changed',
  )
  return c.json({ ok: true, docs } satisfies SyncSubscribeResponse)
}

// The client->server half of the sync protocol: an SSE client has no
// upstream channel of its own, so its messages arrive here.
async function handleMessage(c: Context, admit: WorkspaceAdmit | undefined) {
  const parsed = syncClientMessageRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json(invalidRequestBody(parsed.error), 400)

  const doc = { key: await canonicalDocKey(parsed.data.doc), as: parsed.data.doc }
  const refusal = await firstMembershipRefusal(c, admit, [doc.key])
  if (refusal) return c.json(refusal, 403)

  const stream = syncStreamById(parsed.data.streamId)
  if (!stream) return unknownStream(c, parsed.data.streamId)

  // `client_ready` is the one message a client sends: a viewport request is
  // fired once and never awaited, so there is no acknowledgement message.
  //
  // Upsert rather than require an existing subscription: subscribe and
  // client_ready are separate POSTs with no ordering guarantee between them,
  // and dropping readiness that arrived first would withhold the viewport
  // request for good. Declaring readiness is a statement of interest in the
  // document either way.
  markReady(stream, doc)
  return c.json({ ok: true })
}

export function createSyncSseRouter(options: SyncSseRouterOptions) {
  const app = new Hono()
  // Every workspace-record update the operations commit (ADR-0018) fans out
  // to the SSE audience, from the deps the root handed down — the router no
  // longer resolves a wiring of its own for it.
  options.workspaceDocuments.onUpdated((workspaceId, update) => {
    sseBroadcastWorkspaceUpdate(workspaceId, update)
  })

  app.get('/api/sync/stream', async (c) => {
    // The id is minted here and never accepted from the caller. A client-chosen
    // key into a server-side registry lets one client name another's stream —
    // displacing it on open, or adding and removing that client's
    // subscriptions behind its back. Delivered as the first frame, so holding
    // it is what proves the stream is yours.
    const streamId = globalThis.crypto.randomUUID()
    const userId = (await options.userOf?.(c)) ?? null
    // nginx otherwise holds a proxied stream in a buffer, delaying every update.
    c.header('X-Accel-Buffering', 'no')

    return streamSSE(c, async (stream) => {
      const entry: SyncStream = {
        docs: new Map(),
        send: (event, data) => {
          void stream.writeSSE({ event, data })
        },
        userId,
        end: () => stream.abort(),
      }
      registerSyncStream(streamId, entry)
      const ready: SyncReadyEvent = { streamId }
      await stream.writeSSE({ event: 'ready', data: JSON.stringify(ready) })
      log.info({ streamId }, 'sync stream opened')

      stream.onAbort(() => {
        unregisterSyncStream(streamId)
        log.info({ streamId }, 'sync stream closed')
      })

      // Hold the stream open. streamSSE resolves the callback -> closes the
      // response, so the connection lives exactly as long as this promise.
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve)
      })
    })
  })

  app.post('/api/sync/subscribe', (c) => handleSubscribe(c, options.admit))
  app.post('/api/sync/message', (c) => handleMessage(c, options.admit))

  return app
}
