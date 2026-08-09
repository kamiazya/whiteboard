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
 * rather than just the canvases within one tab.
 */
import type { z } from 'zod'
import {
  syncMessageEventSchema,
  syncReadyEventSchema,
  syncUpdateEventSchema,
} from './sync-sse-contract.js'

interface SseEvent {
  event: string
  data: string
}

/**
 * Split a raw SSE byte stream into events. Separate from the reader loop so a
 * frame arriving split across chunk boundaries — the normal case on a real
 * network — is a testable concern rather than an emergent one.
 */
function createSseFrameParser(): (chunk: string) => SseEvent[] {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    const events: SseEvent[] = []
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      let event = 'message'
      const dataLines: string[] = []
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        // Per the SSE grammar a single event may carry several data: lines,
        // which concatenate with newlines.
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') })
    }
    return events
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
  sendMessage(doc: string, message: unknown): void
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
 *  it returns, without turning into a busy loop against loopback. */
function defaultRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))
}

export interface DocListener {
  onUpdate: (bytes: Uint8Array) => void
  onMessage: (raw: string) => void
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

function isClientReady(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'client_ready'
  )
}

/** Exported so the SharedWorker-backed source decodes with this one
 *  implementation rather than a copy that can drift from it. */
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
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
      void this.send({ subscribe: [doc] })
    }
    entry.listeners.add(listener)
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
      void this.send({ unsubscribe: [doc] })
    }
  }

  sendMessage(doc: string, message: unknown): void {
    // Readiness is stream state, not a one-off event: the daemon only routes
    // viewport requests to streams that declared it, and a reconnect gives us
    // a stream that never has.
    const entry = this.docs.get(doc)
    if (isClientReady(message) && entry) entry.ready = true
    // Before a stream exists there is nothing to address, and the daemon would
    // have nowhere to apply it. Readiness is replayed once one opens; the other
    // control messages are inert server-side, so dropping them costs nothing.
    if (this.streamId === null) return
    void this.post('/api/sync/message', { streamId: this.streamId, doc, message })
  }

  private async post(path: string, body: unknown): Promise<void> {
    try {
      await this.options.fetch(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      // Best effort: a dropped control message is recovered by the next one.
    }
  }

  private async send(body: { subscribe?: string[]; unsubscribe?: string[] }): Promise<void> {
    // Same as sendMessage: with no stream there is nothing to address. The full
    // set is announced when one opens, so an early subscribe is not lost.
    if (this.streamId === null) return
    // Best effort: a dropped subscribe is re-sent when the stream reconnects.
    await this.post('/api/sync/subscribe', { streamId: this.streamId, ...body })
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
    if (this.started || this.closed) return
    this.started = true
    const delayFor = this.options.retryDelayMs ?? defaultRetryDelayMs

    let attempt = 0
    while (!this.closed && this.docs.size > 0) {
      const connected = await this.readStreamOnce()
      if (this.closed || this.docs.size === 0) break
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

    const docs = [...this.docs.keys()]
    if (docs.length > 0) void this.send({ subscribe: docs })
    for (const [doc, entry] of this.docs) {
      if (!entry.ready) continue
      void this.post('/api/sync/message', {
        streamId: payload.streamId,
        doc,
        message: { type: 'client_ready' },
      })
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
      const bytes = fromBase64(payload.update)
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
