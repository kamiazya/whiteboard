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
import type { SseStreamSource } from './sse-stream-hub.js'
import { SseStreamHub } from './sse-stream-hub.js'
import { uploadFiles } from './upload-files.js'
import { parseServerTextMessage } from './ws-text-message.js'

export interface SseTransport {
  fetch: typeof globalThis.fetch
}

export class SseBackend implements CanvasBackend {
  private readonly workspaceId: string
  private readonly slug: string
  private readonly baseUrl: string
  private readonly transport: SseTransport | undefined
  private readonly streamId: string
  private readonly docKey: string

  private readonly streamSource: SseStreamSource | undefined
  private cancelled = false
  private ownedHub: SseStreamHub | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    workspaceId: string,
    slug: string,
    baseUrl: string,
    transport?: SseTransport,
    streamId?: string,
    streamSource?: SseStreamSource,
  ) {
    this.workspaceId = workspaceId
    this.slug = slug
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.transport = transport
    this.streamSource = streamSource
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

    const source = this.resolveSource()
    this.unsubscribe = source.subscribe(this.docKey, {
      onUpdate: (bytes) => handlers.onRemoteUpdate(bytes),
      onMessage: (raw) => this.dispatchText(raw, handlers),
    })
    handlers.onConnected()
  }

  /**
   * The stream this backend talks through. An injected source is the
   * SharedWorker-backed one, shared across tabs; otherwise this backend owns a
   * hub of its own and is responsible for closing it.
   */
  private resolveSource(): SseStreamSource {
    if (this.streamSource) return this.streamSource
    this.ownedHub ??= new SseStreamHub({
      fetch: this.fetchFn,
      baseUrl: this.baseUrl,
      streamId: this.streamId,
    })
    return this.ownedHub
  }

  private dispatchText(raw: string, handlers: CanvasBackendHandlers): void {
    // The payload reuses the WebSocket parser so both transports agree on the
    // shape and on what an unknown message does.
    const message = parseServerTextMessage(raw)
    if (message === null) return
    if (message.type === 'version_created') handlers.onVersionCreated(message.version)
    else if (message.type === 'restore_started') handlers.onRestoreStarted(message)
    else if (message.type === 'restore_complete') handlers.onRestoreComplete()
    else if (message.type === 'head_changed') handlers.onHeadChanged(message)
    else if (message.type === 'viewport_request') handlers.onViewportRequest(message)
    else if (message.type === 'export_request') handlers.onExportRequest(message)
  }

  disconnect(): void {
    this.cancelled = true
    this.unsubscribe?.()
    this.unsubscribe = null
    // Only a hub this backend created is closed here — a shared one outlives
    // any single canvas and is owned by whoever injected it.
    this.ownedHub?.close()
    this.ownedHub = null
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
    this.resolveSource().sendMessage(this.docKey, { type: 'client_ready' })
  }

  sendExportResponse(requestId: string, data: string): void {
    this.resolveSource().sendMessage(this.docKey, { type: 'export_response', requestId, data })
  }
}
