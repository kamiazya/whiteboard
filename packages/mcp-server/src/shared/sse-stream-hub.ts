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
import { createSseFrameParser } from './sse-backend.js'

export interface SseStreamHubOptions {
  fetch: typeof globalThis.fetch
  /** Daemon origin, no trailing slash. */
  baseUrl: string
  streamId: string
}

export interface DocListener {
  onUpdate: (bytes: Uint8Array) => void
  onMessage: (raw: string) => void
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export class SseStreamHub {
  private readonly options: SseStreamHubOptions
  private readonly listeners = new Map<string, Set<DocListener>>()
  private abort: AbortController | null = null
  private started = false

  constructor(options: SseStreamHubOptions) {
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/$/, '') }
  }

  /**
   * Register interest in a document. The first subscriber for a document tells
   * the daemon to route it into this stream; the last one to leave takes it
   * back off, so an abandoned canvas stops costing traffic.
   */
  subscribe(doc: string, listener: DocListener): () => void {
    let set = this.listeners.get(doc)
    if (!set) {
      set = new Set()
      this.listeners.set(doc, set)
      void this.send({ subscribe: [doc] })
    }
    set.add(listener)
    void this.start()

    return () => {
      const current = this.listeners.get(doc)
      if (!current) return
      current.delete(listener)
      if (current.size > 0) return
      this.listeners.delete(doc)
      void this.send({ unsubscribe: [doc] })
    }
  }

  private async send(body: { subscribe?: string[]; unsubscribe?: string[] }): Promise<void> {
    try {
      await this.options.fetch(`${this.options.baseUrl}/api/sync/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId: this.options.streamId, ...body }),
      })
    } catch {
      // Best effort: a dropped subscribe is re-sent when the stream reconnects.
    }
  }

  private async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const abort = new AbortController()
    this.abort = abort

    let res: Response
    try {
      res = await this.options.fetch(
        `${this.options.baseUrl}/api/sync/stream?streamId=${encodeURIComponent(this.options.streamId)}`,
        { signal: abort.signal },
      )
    } catch {
      this.started = false
      return
    }
    if (!res.ok || !res.body) {
      this.started = false
      return
    }

    // The stream is opened lazily by the first subscriber, so subscriptions
    // registered before it existed were answered 404 by the daemon. Re-send
    // them now that there is a stream to attach them to.
    const pending = [...this.listeners.keys()]
    if (pending.length > 0) void this.send({ subscribe: pending })

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
    this.started = false
  }

  private dispatch(evt: { event: string; data: string }): void {
    if (evt.event === 'update') {
      let payload: { doc?: unknown; update?: unknown }
      try {
        payload = JSON.parse(evt.data)
      } catch {
        return
      }
      if (typeof payload.doc !== 'string' || typeof payload.update !== 'string') return
      const set = this.listeners.get(payload.doc)
      if (!set) return
      const bytes = fromBase64(payload.update)
      for (const l of set) l.onUpdate(bytes)
      return
    }
    // Text frames are addressed too, so a version_created for one canvas never
    // reaches another canvas sharing this stream.
    let envelope: { doc?: unknown; raw?: unknown }
    try {
      envelope = JSON.parse(evt.data)
    } catch {
      return
    }
    if (typeof envelope.doc !== 'string' || typeof envelope.raw !== 'string') return
    const set = this.listeners.get(envelope.doc)
    if (!set) return
    for (const l of set) l.onMessage(envelope.raw)
  }

  close(): void {
    this.abort?.abort()
    this.abort = null
    this.listeners.clear()
    this.started = false
  }
}
