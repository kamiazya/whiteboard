/**
 * One SSE stream per daemon origin, shared by every subscriber.
 *
 * Browsers cap concurrent HTTP/1.1 connections per origin at six, and the
 * daemon is served over plain http where browsers do not use HTTP/2 — so a
 * stream per open canvas would starve the daemon's own API once a handful of
 * tabs are open. This hub keeps a single stream and refcounts per-document
 * subscriptions on top of it.
 *
 * It holds no DOM API of its own so it can be tested directly and reused
 * verbatim inside a SharedWorker, which is what makes the sharing span tabs
 * rather than just the documents within one tab.
 */

import { base64ToBytes } from '@kamiazya/whiteboard-model'
import type { z } from 'zod'
import { documentApiUrl, workspaceDocumentApiUrl } from './api-contracts/document-url.js'
import {
  isPermanentWriteRefusal,
  type SyncWriteRefusal,
  SyncWriteRefusedError,
  syncWriteRefusalOf,
} from './api-contracts/sync-write-refusal.js'
import type { ClientTextMessage } from './sync-frames.js'
import {
  MAX_DOCS_PER_STREAM,
  type SyncClientMessageRequest,
  type SyncSubscribeRequest,
  syncMessageEventSchema,
  syncReadyEventSchema,
  syncUpdateEventSchema,
} from './sync-sse-contract.js'

interface SseEvent {
  event: string
  data: string
}

/**
 * One SSE frame — the text between two blank lines — as an event. `null` for
 * a frame carrying no `data:` line at all, which is what a comment or a bare
 * keep-alive is: something arrived, and there is nothing to deliver.
 *
 * Exported for its own test and for nothing else. Measured: every consumer in
 * `dispatch` re-validates through `parseFrame`, so dropping this rule changes
 * nothing a hub-level test can observe — a mutation of it survives the whole
 * suite. The rule is still the right one (an empty event is not an event),
 * and testing it where it lives is the only way to hold it.
 */
export function parseSseEvent(part: string): SseEvent | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of part.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    // Per the SSE grammar a single event may carry several data: lines,
    // which concatenate with newlines.
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  return dataLines.length > 0 ? { event, data: dataLines.join('\n') } : null
}

/**
 * Split a raw SSE byte stream into events. Separate from the reader loop so a
 * frame arriving split across chunk boundaries — the normal case on a real
 * network — is a testable concern rather than an emergent one. The trailing
 * part is held back rather than parsed: with no blank line after it, it is
 * the start of a frame the next chunk finishes.
 */
function createSseFrameParser(): (chunk: string) => SseEvent[] {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    return parts.map(parseSseEvent).filter((event): event is SseEvent => event !== null)
  }
}

/** A source of per-document sync frames. Implemented by SseStreamHub directly,
 *  and by a SharedWorker-backed proxy so the sharing spans tabs. */
export interface SseStreamSource {
  subscribe(doc: string, listener: DocListener): () => void
  /**
   * Send a client->server control message for a document.
   *
   * It belongs here rather than on the caller because the daemon addresses a
   * control message by the stream it applies to, and only the source knows
   * which stream that is — with the SharedWorker-backed source the stream is
   * the worker's, not the caller's.
   */
  sendMessage(doc: string, message: ClientTextMessage): void
  /**
   * Get a document's new state to the authority for it.
   *
   * Which authority that is, is exactly what the two implementations disagree
   * about, and why this belongs on the source rather than at the call site.
   * The hub writes straight to the daemon. The SharedWorker-backed source
   * hands the bytes to the worker's replica, which merges them in arrival
   * order against everything else it knows — its own tabs and the daemon —
   * and writes onward itself. A caller that posted to the daemon directly
   * would be writing around the replica that is meant to be authoritative,
   * and would re-send state the daemon had just delivered.
   *
   * A returned promise REJECTS when the authority did not take the bytes, so
   * a caller holding the only copy can keep holding it. The worker-backed
   * implementation resolves immediately instead — it has handed the bytes to
   * the replica, which owns the retry from there, and a tab that waited on
   * the daemon would be waiting on the wrong thing.
   */
  push(doc: string, update: Uint8Array): void | Promise<void>
  /**
   * The document's current state, for a caller about to reconstruct it.
   *
   * On the source rather than the caller for the same reason `push` is:
   * which authority answers is what the implementations disagree about. The
   * hub asks the daemon; the worker-backed source asks the worker's replica,
   * which is what lets a second tab open a document without any daemon round
   * trip. `null` means the authority does not know the document — fork from
   * empty, the same path a first-ever open takes.
   */
  snapshot(doc: string): Promise<Uint8Array | null>
}

export interface SseStreamHubOptions {
  fetch: typeof globalThis.fetch
  /** Daemon origin, no trailing slash. */
  baseUrl: string
  /**
   * Delay before the nth consecutive reconnect attempt. Injected so a
   * reconnect test asserts the behavior rather than waiting out the backoff.
   */
  retryDelayMs?: (attempt: number) => number
}

/** Exponential with a ceiling: a daemon that is down should be retried until
 *  it returns, without turning into a busy loop against loopback. Exported so
 *  a test reads the schedule itself: every other test injects its own delay,
 *  and past about 23 failures an unclamped one exceeds `setTimeout`'s 2^31 ms
 *  maximum and fires at once. */
export function defaultRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))
}

export interface DocListener {
  onUpdate: (bytes: Uint8Array) => void
  onMessage: (raw: string) => void
  /**
   * Whether a stream is currently carrying this document.
   *
   * A subscriber that is only told about frames cannot distinguish "nothing
   * has changed" from "nothing is arriving", so a dropped stream looks exactly
   * like a quiet one and the UI keeps reporting a connection that is gone.
   * Optional because a caller that only applies updates has no use for it.
   */
  onConnectionChange?: (connected: boolean) => void
  /**
   * Whether the authority has taken every edit handed to `push` for this
   * document. Only a source whose `push` resolves before the write lands —
   * the SharedWorker-backed one — has anything to say here; the hub's push
   * rejects instead, which already tells its caller.
   */
  onWriteState?: (landed: boolean) => void
  /**
   * The authority refused a write for what its bytes would do, permanently:
   * it has stopped offering them and holds the keeper's state again, so the
   * caller has to take that state too — its own copy still carries the
   * refused ops, and every edit built on them is refused with them. Only a
   * source whose `push` resolves before the write lands says this; the
   * hub's push rejects with `SyncWriteRefusedError` instead.
   */
  onWriteRefused?: (refusal: SyncWriteRefusal) => void
  /**
   * The daemon refused the credential this stream carries — a 401 or 403 on
   * the stream itself, or on a push for this document. Not a dropped
   * connection: the hub stops reconnecting, because retrying a refused
   * credential is the same answer every backoff step while the page reads
   * the silence as "reconnecting". The one way out is a fresh page or
   * worker, since the page holds no credential of its own to renew.
   */
  onAuthRefused?: () => void
}

/** The two answers that mean the credential, not the connection, is the problem. */
function isAuthRefusal(status: number): boolean {
  return status === 401 || status === 403
}

/**
 * The workspace-granularity doc key: one subscription for the whole
 * workspace document. Unambiguous against `${workspaceId}/${path}` keys
 * because a workspace id contains no ':' and no '/', so no per-document
 * key ever starts with this prefix without a slash following it.
 */
const WORKSPACE_DOC_KEY_PREFIX = 'workspace:'

export function workspaceDocKey(workspaceId: string): string {
  return `${WORKSPACE_DOC_KEY_PREFIX}${workspaceId}`
}

/**
 * The per-document sync key: `${handle}/${path}`, the grammar
 * `workspaceHandleOfSyncKey` splits on the first slash. The daemon's stream
 * registry, the client backend and the page's identity key all spell it
 * through here, so a change to the join reaches the parser it must agree with.
 */
export function documentSyncKey(handle: string, path: string): string {
  return `${handle}/${path}`
}

/**
 * The workspace id a workspace-granularity sync key names, or `null` for any
 * other key — a per-document key, the bare prefix, or the STORED key shape
 * (`workspace-tree:<id>`, ports' `docRefKey`, a different grammar).
 */
export function workspaceIdOfSyncKey(doc: string): string | null {
  if (!doc.startsWith(WORKSPACE_DOC_KEY_PREFIX)) return null
  const workspaceId = doc.slice(WORKSPACE_DOC_KEY_PREFIX.length)
  return workspaceId.length === 0 ? null : workspaceId
}

/**
 * The workspace a sync key addresses, for a caller that needs it rather than
 * the route — the daemon's membership gate, in particular, decides once per
 * workspace rather than per document key. A `workspace:` key names it
 * directly; a per-document key is `${handle}/${path}`, split on the first
 * slash (a path may contain more, a handle never does). What comes back is
 * the HANDLE the client wrote, which a daemon resolves to an id before it
 * keys anything by it. `null` for a malformed key — `canvasDocUrl` refuses
 * through this same split.
 */
export function workspaceHandleOfSyncKey(doc: string): string | null {
  if (doc.startsWith(WORKSPACE_DOC_KEY_PREFIX)) return workspaceIdOfSyncKey(doc)
  const slash = doc.indexOf('/')
  if (slash <= 0 || slash === doc.length - 1) return null
  return doc.slice(0, slash)
}

/**
 * The daemon's update route for a doc key.
 *
 * A per-document key IS `${workspaceId}/${path}`, which is the only reason
 * anything holding just the key can address this route (first slash only: a
 * path may contain more, a workspace id never does). A `workspace:` key
 * addresses the workspace-document routes instead.
 */
export function documentUpdateUrl(baseUrl: string, doc: string): string | null {
  return canvasDocUrl(baseUrl, doc, 'update')
}

/** The snapshot twin of `documentUpdateUrl`, splitting on the same first slash. */
export function canvasSnapshotUrl(baseUrl: string, doc: string): string | null {
  return canvasDocUrl(baseUrl, doc, 'snapshot')
}

function canvasDocUrl(baseUrl: string, doc: string, action: 'update' | 'snapshot'): string | null {
  const base = baseUrl.replace(/\/$/, '')
  const workspaceId = workspaceHandleOfSyncKey(doc)
  if (workspaceId === null) return null
  if (workspaceIdOfSyncKey(doc) !== null) {
    return `${base}${workspaceDocumentApiUrl(workspaceId, action)}`
  }
  // Raw halves: documentApiUrl encodes per segment itself.
  return `${base}${documentApiUrl(workspaceId, doc.slice(workspaceId.length + 1), action)}`
}

/**
 * Parse one frame's `data` against its contract. A malformed frame is dropped
 * rather than thrown on: the daemon is the only producer, so a mismatch is a
 * version skew, and losing one frame is recoverable where aborting the whole
 * stream would stop every document sharing it.
 */
function parseFrame<T extends z.ZodTypeAny>(schema: T, data: string): z.infer<T> | null {
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = schema.safeParse(json)
  return parsed.success ? parsed.data : null
}

export class SseStreamHub implements SseStreamSource {
  private readonly options: SseStreamHubOptions
  /**
   * One record per document. `ready` lives beside the listeners rather than in
   * a set of its own so it cannot outlive the subscription it describes:
   * releasing a document is a single delete, with nothing left to forget.
   */
  private readonly docs = new Map<string, { listeners: Set<DocListener>; ready: boolean }>()
  private abort: AbortController | null = null
  /** Minted by the daemon and delivered on the stream itself, so it exists only
   *  between a stream opening and that stream ending. */
  private streamId: string | null = null
  private started = false
  private closed = false
  /** Set by a 401/403; the reconnect loop halts on it for this hub's life. */
  private authRefused = false
  /**
   * Documents the daemon refused to follow on the stream that is open — a
   * workspace the credential no longer enters, or past the stream's limit.
   * Kept so a subscriber joining later is told the truth rather than the
   * stream's liveness, and forgotten with the stream it describes.
   */
  private readonly unfollowed = new Set<string>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryResolve: (() => void) | null = null

  constructor(options: SseStreamHubOptions) {
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/$/, '') }
  }

  /**
   * Register interest in a document. The first subscriber for a document tells
   * the daemon to route it into this stream; the last one to leave takes it
   * back off, so an abandoned canvas stops costing traffic.
   */
  subscribe(doc: string, listener: DocListener): () => void {
    let entry = this.docs.get(doc)
    if (!entry) {
      entry = { listeners: new Set(), ready: false }
      this.docs.set(doc, entry)
      void this.follow([doc])
    }
    entry.listeners.add(listener)
    // Announced on transitions alone, liveness would never reach anyone who
    // joins a stream that is already open — a second canvas in the same tab
    // would show an unknown connection for as long as nothing went wrong.
    listener.onConnectionChange?.(this.streamId !== null && !this.unfollowed.has(doc))
    void this.start()

    return () => {
      const current = this.docs.get(doc)
      if (!current) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      // One delete drops the readiness with it. Kept apart, it would survive
      // here and keep declaring every reconnected stream ready for a canvas
      // nobody is watching.
      this.docs.delete(doc)
      this.unfollowed.delete(doc)
      void this.send({ unsubscribe: [doc] })
    }
  }

  sendMessage(doc: string, message: ClientTextMessage): void {
    // Readiness is stream state, not a one-off event: the daemon only routes
    // viewport requests to streams that declared it, and a reconnect gives us
    // a stream that never has.
    const entry = this.docs.get(doc)
    if (message.type === 'client_ready' && entry) entry.ready = true
    // Before a stream exists there is nothing to address, and the daemon would
    // have nowhere to apply it. Readiness is replayed once one opens; the other
    // control messages are inert server-side, so dropping them costs nothing.
    if (this.streamId === null) return
    void this.post('/api/sync/message', {
      streamId: this.streamId,
      doc,
      message,
    } satisfies SyncClientMessageRequest)
  }

  /**
   * Straight to the daemon: with no worker in front, the daemon IS the
   * authority. The existing update route already imports, persists and
   * broadcasts, and its broadcast reaches SSE subscribers, so sync needs no
   * endpoint of its own.
   */
  async push(doc: string, update: Uint8Array): Promise<void> {
    const url = documentUpdateUrl(this.options.baseUrl, doc)
    if (url === null) throw new Error(`not a document key: ${doc}`)
    const res = await this.options.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      // `.buffer` of a fresh slice, not the view: this module is also built
      // for Node's dts pass, where the DOM's BodyInit type is unavailable.
      body: update.slice().buffer as ArrayBuffer,
    })
    // A refusal that ANSWERS is the shape a restarting daemon produces, and it
    // is the one a bare `.catch()` cannot see: fetch resolves for a 503, so a
    // writer that only guards against rejection counts it as delivered and
    // moves its acknowledged version forward over an edit the daemon never
    // took. Failing loudly here is what lets a caller keep the bytes.
    // A refusal of the CREDENTIAL is told to the document's subscribers as
    // well: the stream can stay open under a credential the daemon no longer
    // accepts for writes (a membership revoked mid-session), so the push is
    // the only place that refusal is visible.
    if (isAuthRefusal(res.status)) this.announceAuthRefused([this.docs.get(doc)])
    // A refusal of the BYTES is told apart from the rest, with the keeper's
    // reason: sending them again gets the same answer, so a caller that
    // retried it would keep every later edit built on them unsaved forever.
    if (isPermanentWriteRefusal(res.status)) {
      const body: unknown = await res.json().catch(() => undefined)
      throw new SyncWriteRefusedError(res.status, syncWriteRefusalOf(body))
    }
    if (!res.ok) throw new Error(`update refused: ${res.status}`)
  }

  /**
   * The document's current state, from the daemon. The SSE stream carries
   * only INCREMENTAL updates from subscription onward — the subscribe route
   * registers routing and seeds nothing — so anything reconstructing a
   * document needs this once before the stream's deltas mean anything.
   *
   * `null` for a document the daemon does not know: forking from empty is
   * the same path a first-ever open takes, and conflating that answer with a
   * transport failure is how a reachable daemon gets treated as an absent
   * one. Everything else non-ok throws, same reasoning as `push`.
   */
  async snapshot(doc: string): Promise<Uint8Array | null> {
    const url = canvasSnapshotUrl(this.options.baseUrl, doc)
    if (url === null) throw new Error(`not a document key: ${doc}`)
    const res = await this.options.fetch(url)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`snapshot refused: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  // Typed at every call site against the contract the daemon parses
  // `.strict()`: a body shaped by hand answered 400, which this swallows as
  // best-effort, and sync stopped delivering with nothing red.
  private async post(
    path: '/api/sync/subscribe' | '/api/sync/message',
    body: SyncSubscribeRequest | SyncClientMessageRequest,
  ): Promise<number | null> {
    try {
      const res = await this.options.fetch(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.status
    } catch {
      // Best effort: a dropped control message is recovered by the next one.
      return null
    }
  }

  private async send(body: Omit<SyncSubscribeRequest, 'streamId'>): Promise<number | null> {
    // Same as sendMessage: with no stream there is nothing to address. The full
    // set is announced when one opens, so an early subscribe is not lost.
    if (this.streamId === null) return null
    // Best effort: a dropped subscribe is re-sent when the stream reconnects.
    return await this.post('/api/sync/subscribe', {
      streamId: this.streamId,
      ...body,
    } satisfies SyncSubscribeRequest)
  }

  /**
   * Ask the daemon to route documents into the stream, one request per
   * workspace and no more than a request may carry.
   *
   * The daemon decides a request as a whole — it refuses all of it for the
   * first workspace the credential may not enter — so one request for
   * everything the page follows lets a single revoked workspace end live
   * sync for every unrelated document, and a count past the stream's limit
   * ends it for all of them. Split this way a refusal costs exactly the
   * documents it concerns, and those are told.
   */
  private async follow(docs: readonly string[]): Promise<void> {
    const byWorkspace = new Map<string, string[]>()
    for (const doc of docs) {
      const workspaceId = workspaceHandleOfSyncKey(doc) ?? ''
      byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), doc])
    }
    for (const group of byWorkspace.values()) {
      for (let from = 0; from < group.length; from += MAX_DOCS_PER_STREAM) {
        const chunk = group.slice(from, from + MAX_DOCS_PER_STREAM)
        const status = await this.send({ subscribe: chunk })
        if (status !== null && (status < 200 || status >= 300)) this.refuse(status, chunk)
      }
    }
  }

  /**
   * Tell the subscribers of documents the daemon would not follow. A refused
   * credential says so, as it does everywhere else; any other refusal leaves
   * the document without a live stream, which is what "not connected" means
   * to its subscriber. The stream itself stays: it still carries the rest.
   */
  private refuse(status: number, docs: readonly string[]): void {
    for (const doc of docs) this.unfollowed.add(doc)
    const entries = docs.map((doc) => this.docs.get(doc))
    if (isAuthRefusal(status)) {
      this.announceAuthRefused(entries)
      return
    }
    for (const entry of entries) this.announceTo(entry, false)
  }

  /**
   * Keep a stream open for as long as anything is subscribed.
   *
   * A stream that ends is not a terminal condition — the daemon restarts, a
   * laptop sleeps, a proxy times the connection out — and a client that does
   * not come back keeps its listeners registered while silently receiving
   * nothing, so the canvas looks connected while it diverges.
   */
  private async start(): Promise<void> {
    if (this.started || this.closed || this.authRefused) return
    this.started = true
    const delayFor = this.options.retryDelayMs ?? defaultRetryDelayMs

    let attempt = 0
    while (!this.closed && !this.authRefused && this.docs.size > 0) {
      const connected = await this.readStreamOnce()
      if (this.closed || this.authRefused || this.docs.size === 0) break
      attempt = connected ? 0 : attempt + 1
      await this.wait(delayFor(attempt))
    }
    this.started = false
  }

  /** Opens the stream and reads it to its end. Resolves to whether it opened,
   *  which is what decides between resetting and growing the backoff. */
  private async readStreamOnce(): Promise<boolean> {
    const abort = new AbortController()
    this.abort = abort

    let res: Response
    try {
      res = await this.options.fetch(`${this.options.baseUrl}/api/sync/stream`, {
        signal: abort.signal,
      })
    } catch {
      return false
    }
    if (!res.ok || !res.body) {
      // An unconsumed body holds the connection open under undici, and the
      // reconnect loop would repeat that on every failed attempt.
      void res.body?.cancel().catch(() => {})
      if (isAuthRefusal(res.status)) {
        this.authRefused = true
        this.announceAuthRefused(this.docs.values())
      }
      return false
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parse = createSseFrameParser()
    try {
      while (this.abort === abort) {
        const { value, done } = await reader.read()
        if (done) break
        for (const evt of parse(decoder.decode(value, { stream: true }))) this.dispatch(evt)
      }
    } catch {
      // An aborted read is the normal shutdown path.
    }
    // The id belongs to the stream that just ended; nothing may be addressed
    // to it until the next one announces its own.
    this.streamId = null
    this.unfollowed.clear()
    this.announceConnection(false)
    return true
  }

  /**
   * Adopt the id the daemon minted for this stream and announce the full state
   * against it — the daemon knows nothing about a stream until it opens, and
   * forgets it when it drops, so both the subscriptions registered before this
   * stream existed and the readiness declared against the previous one have to
   * be repeated.
   */
  private onStreamReady(data: string): void {
    const payload = parseFrame(syncReadyEventSchema, data)
    if (!payload) return
    this.streamId = payload.streamId
    this.announceConnection(true)

    const docs = [...this.docs.keys()]
    if (docs.length > 0) void this.follow(docs)
    for (const [doc, entry] of this.docs) {
      if (!entry.ready) continue
      void this.post('/api/sync/message', {
        streamId: payload.streamId,
        doc,
        message: { type: 'client_ready' },
      } satisfies SyncClientMessageRequest)
    }
  }

  /** A subscriber that throws must not stop the others from being told. */
  private announceConnection(connected: boolean): void {
    for (const entry of this.docs.values()) this.announceTo(entry, connected)
  }

  private announceTo(entry: { listeners: Set<DocListener> } | undefined, connected: boolean): void {
    for (const listener of entry?.listeners ?? []) {
      try {
        listener.onConnectionChange?.(connected)
      } catch {
        // A listener's own failure is not this hub's to propagate.
      }
    }
  }

  /** Same rule as `announceConnection`: one listener's throw stops nobody else. */
  private announceAuthRefused(
    entries: Iterable<{ listeners: Set<DocListener> } | undefined>,
  ): void {
    for (const entry of entries) {
      for (const listener of entry?.listeners ?? []) {
        try {
          listener.onAuthRefused?.()
        } catch {
          // A listener's own failure is not this hub's to propagate.
        }
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // Held so close() can settle it. Clearing the timer alone would leave
      // this promise pending forever, and with it the start() frame that
      // awaits it — keeping the whole hub reachable.
      this.retryResolve = resolve
      this.retryTimer = setTimeout(resolve, ms)
    })
  }

  private dispatch(evt: { event: string; data: string }): void {
    if (evt.event === 'ready') {
      this.onStreamReady(evt.data)
      return
    }
    if (evt.event === 'update') {
      const payload = parseFrame(syncUpdateEventSchema, evt.data)
      if (!payload) return
      const entry = this.docs.get(payload.doc)
      if (!entry) return
      // Dropped like any other frame that does not parse: one corrupt update
      // must not take the whole stream down with it.
      const bytes = base64ToBytes(payload.update)
      if (bytes === null) return
      for (const l of entry.listeners) l.onUpdate(bytes)
      return
    }
    // Text frames are addressed too, so a version_created for one canvas never
    // reaches another canvas sharing this stream.
    const envelope = parseFrame(syncMessageEventSchema, evt.data)
    if (!envelope) return
    const entry = this.docs.get(envelope.doc)
    if (!entry) return
    for (const l of entry.listeners) l.onMessage(envelope.raw)
  }

  close(): void {
    this.closed = true
    this.abort?.abort()
    this.abort = null
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    // Settle a wait in flight: the loop awaiting it checks `closed` and exits.
    this.retryResolve?.()
    this.retryResolve = null
    this.docs.clear()
    this.started = false
  }
}
