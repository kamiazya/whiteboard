/**
 * SseBackend: the CanvasBackend for a page that has no WebSocket path to the
 * daemon.
 *
 * A page served over https cannot open a `ws://` socket to loopback — mixed
 * content blocks the upgrade before auth is attempted — while a plain `http://`
 * fetch to loopback stays allowed. The hosted web app therefore syncs over SSE
 * downstream with ordinary POSTs upstream.
 *
 * The stream is read with `fetch` + `ReadableStream` rather than `EventSource`:
 * EventSource cannot carry an Authorization header, and the alternative — the
 * bearer token in the query string — would put a credential into URLs, history
 * and any access log that sees it. Reading the body ourselves keeps the token
 * in a header and works unchanged inside a SharedWorker.
 */
import { apiFetch } from './api-client.js'
import type {
  BinaryFileDataLike,
  CanvasBackend,
  CanvasBackendHandlers,
} from './canvas-backend-contract.js'
import { uploadFiles } from './upload-files.js'
import { parseServerTextMessage } from './ws-text-message.js'

export interface SseTransport {
  fetch: typeof globalThis.fetch
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

interface SseEvent {
  event: string
  data: string
}

/**
 * Split a raw SSE byte stream into events. Kept separate from the backend so a
 * frame arriving split across chunk boundaries — the normal case on a real
 * network — is a testable concern rather than an emergent one.
 */
export function createSseFrameParser(): (chunk: string) => SseEvent[] {
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

export class SseBackend implements CanvasBackend {
  private readonly workspaceId: string
  private readonly slug: string
  private readonly baseUrl: string
  private readonly transport: SseTransport | undefined
  private readonly streamId: string
  private readonly docKey: string

  private cancelled = false
  private abort: AbortController | null = null

  constructor(
    workspaceId: string,
    slug: string,
    baseUrl: string,
    transport?: SseTransport,
    streamId?: string,
  ) {
    this.workspaceId = workspaceId
    this.slug = slug
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.transport = transport
    this.docKey = `${workspaceId}/${slug}`
    this.streamId =
      streamId ??
      globalThis.crypto?.randomUUID?.() ??
      `s-${Math.random().toString(36).slice(2)}-fallback`
  }

  private get fetchFn(): typeof globalThis.fetch {
    return this.transport?.fetch ?? (apiFetch as unknown as typeof globalThis.fetch)
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  connect(handlers: CanvasBackendHandlers): void {
    this.cancelled = false
    void this.run(handlers)
  }

  private async run(handlers: CanvasBackendHandlers): Promise<void> {
    // Snapshot first: the stream carries only incremental updates, so a client
    // that started reading before seeding would apply deltas to an empty doc.
    try {
      const res = await this.fetchFn(
        this.url(
          `/api/canvas/${encodeURIComponent(this.workspaceId)}/${encodeURIComponent(this.slug)}/snapshot`,
        ),
      )
      if (this.cancelled) return
      if (res.ok) {
        handlers.onSnapshot(new Uint8Array(await res.arrayBuffer()))
      }
    } catch {
      // A failed snapshot is not terminal: the stream may still connect and the
      // caller keeps whatever document state it already had.
    }
    if (this.cancelled) return

    const abort = new AbortController()
    this.abort = abort
    let streamRes: Response
    try {
      streamRes = await this.fetchFn(
        this.url(`/api/sync/stream?streamId=${encodeURIComponent(this.streamId)}`),
        { signal: abort.signal },
      )
    } catch {
      if (!this.cancelled) handlers.onAuthError?.()
      return
    }
    if (this.cancelled) return
    if (!streamRes.ok || !streamRes.body) {
      handlers.onAuthError?.()
      return
    }

    // Subscribe only once the stream exists — the daemon answers 404 for a
    // stream it does not know, so subscribing first would race the open.
    await this.post('/api/sync/subscribe', { streamId: this.streamId, subscribe: [this.docKey] })
    handlers.onConnected()

    const reader = streamRes.body.getReader()
    const decoder = new TextDecoder()
    const parse = createSseFrameParser()
    try {
      while (!this.cancelled) {
        const { value, done } = await reader.read()
        if (done) break
        for (const evt of parse(decoder.decode(value, { stream: true }))) {
          this.dispatch(evt, handlers)
        }
      }
    } catch {
      // An aborted read is the normal disconnect path.
    }
  }

  private dispatch(evt: SseEvent, handlers: CanvasBackendHandlers): void {
    if (evt.event === 'update') {
      let payload: { doc?: unknown; update?: unknown }
      try {
        payload = JSON.parse(evt.data)
      } catch {
        return
      }
      // One stream serves many documents, so a frame for another canvas is
      // expected traffic, not an error.
      if (payload.doc !== this.docKey || typeof payload.update !== 'string') return
      handlers.onRemoteUpdate(fromBase64(payload.update))
      return
    }
    // A text frame is addressed too: one stream serves many canvases, so an
    // unaddressed message would be applied to whichever one is listening.
    let envelope: { doc?: unknown; raw?: unknown }
    try {
      envelope = JSON.parse(evt.data)
    } catch {
      return
    }
    if (envelope.doc !== this.docKey || typeof envelope.raw !== 'string') return
    // The payload itself reuses the WebSocket parser so both transports agree
    // on the shape and on what an unknown message does.
    const message = parseServerTextMessage(envelope.raw)
    if (message === null) return
    if (message.type === 'version_created') handlers.onVersionCreated(message.version)
    else if (message.type === 'restore_started') handlers.onRestoreStarted(message)
    else if (message.type === 'restore_complete') handlers.onRestoreComplete()
    else if (message.type === 'head_changed') handlers.onHeadChanged(message)
    else if (message.type === 'viewport_request') handlers.onViewportRequest(message)
    else if (message.type === 'export_request') handlers.onExportRequest(message)
  }

  private async post(path: string, body: unknown): Promise<void> {
    try {
      await this.fetchFn(this.url(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      // Best effort: a dropped control message is recovered by the next one
      // (subscribe is re-sent on reconnect, client_ready on the next ready).
    }
  }

  disconnect(): void {
    this.cancelled = true
    this.abort?.abort()
    this.abort = null
  }

  pushLocalUpdate(bytes: Uint8Array): void {
    // The existing update route already imports, persists and broadcasts, and
    // its broadcast now reaches SSE subscribers too — no sync-specific upstream
    // endpoint is needed.
    void this.fetchFn(
      this.url(
        `/api/canvas/${encodeURIComponent(this.workspaceId)}/${encodeURIComponent(this.slug)}/update`,
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        // `.buffer` of a fresh slice, not the view: this module is also built
        // for Node's dts pass, where the DOM's BodyInit type is unavailable.
        body: bytes.slice().buffer as ArrayBuffer,
      },
    ).catch(() => {
      // Dropping a local update here would lose the edit silently; the caller's
      // CRDT still holds it and the next update carries the same state forward.
    })
  }

  async getFile(fileId: string): Promise<Blob | null> {
    const res = await this.fetchFn(
      this.url(
        `/api/canvas/${encodeURIComponent(this.workspaceId)}/${encodeURIComponent(this.slug)}/file/${encodeURIComponent(fileId)}`,
      ),
    )
    if (!res.ok) return null
    return res.blob()
  }

  async putFile(
    newEntries: [string, BinaryFileDataLike][],
    onFileSuccess: (fileId: string) => void,
  ): Promise<void> {
    await uploadFiles(newEntries, this.workspaceId, this.slug, onFileSuccess, this.transport?.fetch)
  }

  sendClientReady(): void {
    void this.post('/api/sync/message', {
      streamId: this.streamId,
      doc: this.docKey,
      message: { type: 'client_ready' },
    })
  }

  sendExportResponse(requestId: string, data: string): void {
    void this.post('/api/sync/message', {
      streamId: this.streamId,
      doc: this.docKey,
      message: { type: 'export_response', requestId, data },
    })
  }
}
