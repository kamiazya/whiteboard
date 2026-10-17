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
  workspaceDocKey,
  workspaceHandleOfSyncKey,
  workspaceIdOfSyncKey,
} from '@kamiazya/whiteboard-daemon-client/sync-key'
import {
  MAX_DOCS_PER_STREAM,
  type SyncReadyEvent,
  type SyncSubscribeResponse,
  syncClientMessageRequestSchema,
  syncSubscribeRequestSchema,
} from '@kamiazya/whiteboard-daemon-client/sync-sse-contract'
import { errorBody, invalidRequestBody, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { type SSEStreamingApi, streamSSE } from 'hono/streaming'
import { getLogger } from '../log.js'
import type { WorkspaceAdmit } from '../security/membership-gate.js'
import { membershipRefusal } from '../security/workspace-access.js'
import {
  chargeSyncStreamQueue,
  docKey,
  MAX_QUEUED_STREAM_CHARS,
  registerSyncStream,
  releaseSyncStreamQueue,
  type SyncQueueBudget,
  type SyncStream,
  type SyncStreamCaps,
  type SyncStreamDoc,
  sseBroadcastWorkspaceUpdate,
  syncStreamById,
  syncStreamCapReached,
  unregisterSyncStream,
} from '../sync-streams.js'
import { cachedViewportRequest } from '../viewport-requests.js'
import { callerNamespaceOf, resolveWorkspaceHandleToId } from '../workspace-handle.js'
import { type ReadJsonBodyOptions, readJsonBody } from './read-json-body.js'

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
  resolve: (handle: string) => Promise<string>,
): Promise<string> {
  const handle = workspaceHandleOfSyncKey(key)
  if (handle === null) return key
  const workspaceId = await resolve(handle)
  if (workspaceId === handle) return key
  return workspaceIdOfSyncKey(key) !== null
    ? workspaceDocKey(workspaceId)
    : docKey(workspaceId, key.slice(handle.length + 1))
}

/**
 * Each key as the client wrote it, beside its canonical form. A handle is
 * resolved once however many keys name it, since each resolution reads the
 * workspace registry — and in the caller's namespace, as every address is.
 */
async function canonicalKeys(
  c: Context,
  keys: readonly string[],
): Promise<Array<{ key: string; as: string }>> {
  const resolutions = new Map<string, Promise<string>>()
  const resolve = (handle: string) => {
    let resolution = resolutions.get(handle)
    if (resolution === undefined) {
      resolution = resolveWorkspaceHandleToId(handle, callerNamespaceOf(c))
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
  /** Whether a user still reaches a workspace — re-asked before a broadcast
   *  goes down their stream. Absent: nobody can lose access. */
  holdsAccess?: (userId: string, workspaceId: string) => Promise<boolean>
  /** How many streams one user, and everyone, may hold open. Absent: no cap
   *  (the local daemon, whose one person's tabs must never be refused). */
  streamCaps?: SyncStreamCaps
  /** How much undelivered data one user's streams, and every stream, may
   *  hold together. Absent: `SYNC_QUEUE_BUDGET`, on both keepers. */
  queueBudget?: SyncQueueBudget
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
    const workspaceId = workspaceHandleOfSyncKey(key)
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
  if (cached !== undefined) stream.send({ event: 'message', data: { doc: doc.as, raw: cached } })
}

const SYNC_BODY: ReadJsonBodyOptions = { voice: 'code', refuseShape: invalidRequestBody }

/**
 * The stream a sync POST addresses, or the refusal to answer instead.
 *
 * Losing access ends the streams of the user who OPENED them, so a stream
 * answers to that user alone: subscribed by anyone else — a second account, a
 * bearer naming nobody — it would outlive its subscriber's removal and keep
 * delivering a workspace they may no longer read.
 */
async function callersStream(
  c: Context,
  options: SyncSseRouterOptions,
  streamId: string,
): Promise<SyncStream | Response> {
  const stream = syncStreamById(streamId)
  // A request for a stream that is not open is a client bug (a race with
  // reconnect, a stale streamId). Answering 200 would leave the caller
  // believing it is subscribed and waiting forever for updates.
  if (!stream) return unknownStream(c, streamId)
  if (options.userOf === undefined) return stream
  const caller = await options.userOf(c)
  if (caller !== null && caller === stream.userId) return stream
  log.warning({ streamId }, 'sync request refused: the stream is not the caller’s')
  return c.json(errorBody('not_stream_owner', 'this stream was opened by someone else'), 403)
}

async function handleSubscribe(c: Context, options: SyncSseRouterOptions) {
  const { admit } = options
  const parsed = await readJsonBody(c, syncSubscribeRequestSchema, SYNC_BODY)
  if ('refusal' in parsed) return parsed.refusal

  // Resolved before the gate, so membership is decided for the workspace
  // a key actually reaches, whichever handle named it.
  const subscribe = await canonicalKeys(c, parsed.data.subscribe ?? [])
  // Dropped by the spelling it was subscribed under, so no resolution.
  const unsubscribe = parsed.data.unsubscribe ?? []

  const refusal = await firstMembershipRefusal(
    c,
    admit,
    subscribe.map(({ key }) => key),
  )
  if (refusal) return c.json(refusal, 403)

  const stream = await callersStream(c, options, parsed.data.streamId)
  if (stream instanceof Response) return stream

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
async function handleMessage(c: Context, options: SyncSseRouterOptions) {
  const { admit } = options
  const parsed = await readJsonBody(c, syncClientMessageRequestSchema, SYNC_BODY)
  if ('refusal' in parsed) return parsed.refusal

  const doc = {
    key: await canonicalDocKey(parsed.data.doc, (handle) =>
      resolveWorkspaceHandleToId(handle, callerNamespaceOf(c)),
    ),
    as: parsed.data.doc,
  }
  const refusal = await firstMembershipRefusal(c, admit, [doc.key])
  if (refusal) return c.json(refusal, 403)

  const stream = await callersStream(c, options, parsed.data.streamId)
  if (stream instanceof Response) return stream

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

/**
 * The refusal to answer a stream open with, if any. Where the keeper knows
 * people, a stream nobody owns is one no revocation could ever end; and one
 * user, or everyone together, may hold only so many.
 */
function openRefusal(c: Context, options: SyncSseRouterOptions, userId: string | null) {
  if (options.userOf === undefined) return null
  if (userId === null) {
    log.warning({}, 'sync stream refused: the caller is no user of this keeper')
    return c.json(membershipRefusal('requires_person_session'), 403)
  }
  const cap = options.streamCaps && syncStreamCapReached(userId, options.streamCaps)
  if (!cap) return null
  log.warning({ userId, cap }, 'sync stream refused: too many open')
  c.header('Retry-After', '5')
  const message =
    cap === 'per_user'
      ? 'this user already holds as many sync streams as the keeper allows'
      : 'the keeper holds as many sync streams as it allows'
  return c.json(errorBody('too_many_streams', message), 429)
}

/** The registry's handle on one open stream. */
function streamEntry(
  stream: SSEStreamingApi,
  streamId: string,
  userId: string | null,
  options: Pick<SyncSseRouterOptions, 'holdsAccess' | 'queueBudget'>,
): SyncStream {
  const { holdsAccess } = options
  // What has been written and not yet taken by the reader: a write settles
  // once the response body is read past it.
  let queued = 0
  return {
    docs: new Map(),
    send: ({ event, data }) => {
      if (stream.aborted) return
      const payload = JSON.stringify(data)
      queued += payload.length
      if (queued > MAX_QUEUED_STREAM_CHARS) {
        unregisterSyncStream(streamId)
        log.warning({ streamId, queued }, 'sync stream ended: its reader fell too far behind')
        stream.abort()
        return
      }
      void stream.writeSSE({ event, data: payload }).finally(() => {
        queued -= payload.length
        releaseSyncStreamQueue(streamId, payload.length)
      })
      chargeSyncStreamQueue(streamId, payload.length, options.queueBudget)
    },
    userId,
    ...(userId === null || holdsAccess === undefined
      ? {}
      : { admits: (workspaceId: string) => holdsAccess(userId, workspaceId) }),
    end: () => stream.abort(),
  }
}

/** Registers an opened stream, sends its id, and holds it open until it ends. */
async function holdStream(
  stream: SSEStreamingApi,
  streamId: string,
  userId: string | null,
  options: SyncSseRouterOptions,
): Promise<void> {
  registerSyncStream(streamId, streamEntry(stream, streamId, userId, options))
  // Listening before the first await: an abort that lands while the ready
  // frame is written fires no listener added after it, which would leave
  // the stream registered and this callback waiting forever.
  const closed = new Promise<void>((resolve) => {
    stream.onAbort(() => {
      unregisterSyncStream(streamId)
      log.info({ streamId }, 'sync stream closed')
      resolve()
    })
  })
  const ready: SyncReadyEvent = { streamId }
  await stream.writeSSE({ event: 'ready', data: JSON.stringify(ready) })
  if (stream.aborted) {
    unregisterSyncStream(streamId)
    return
  }
  log.info({ streamId }, 'sync stream opened')

  // Hold the stream open. streamSSE resolves the callback -> closes the
  // response, so the connection lives exactly as long as this promise.
  await closed
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
    const refusal = openRefusal(c, options, userId)
    if (refusal) return refusal
    // nginx otherwise holds a proxied stream in a buffer, delaying every update.
    c.header('X-Accel-Buffering', 'no')

    return streamSSE(c, (stream) => holdStream(stream, streamId, userId, options))
  })

  app.post('/api/sync/subscribe', (c) => handleSubscribe(c, options))
  app.post('/api/sync/message', (c) => handleMessage(c, options))

  return app
}
