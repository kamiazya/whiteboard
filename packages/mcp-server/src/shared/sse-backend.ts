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
import { canvasFileApiUrl } from './api-contracts/canvas-url.js'
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
    streamSource?: SseStreamSource,
  ) {
    this.workspaceId = workspaceId
    this.slug = slug
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.transport = transport
    this.streamSource = streamSource
    this.docKey = `${workspaceId}/${slug}`
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
    // Through the source, not a direct fetch, for the same reason push is:
    // which authority answers is the implementations' difference. The hub
    // asks the daemon (the same GET this method used to make itself); the
    // worker-backed source asks the worker's replica, so a second tab opens
    // without a daemon round trip and off this thread.
    try {
      const bytes = await this.resolveSource().snapshot(this.docKey)
      if (this.cancelled) return
      // `null` is "the authority does not know this document" — the caller
      // keeps its own state and the stream fills in from empty, the same
      // path a first-ever open takes.
      if (bytes !== null && bytes.byteLength > 0) {
        handlers.onSnapshot(bytes)
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
      // The stream belongs to the source, so its liveness is the only signal
      // this backend has that updates are still arriving.
      onConnectionChange: (connected) => {
        if (this.cancelled) return
        if (connected) handlers.onConnected()
        else handlers.onDisconnected?.()
      },
    })
    // No unconditional report here: the source announces its state at
    // subscribe time and on every change, so anything added on top would
    // either overwrite an accurate "not connected yet" or double-report a
    // connection — and the session sends client_ready per report.
  }

  /**
   * The stream this backend talks through. An injected source is the
   * SharedWorker-backed one, shared across tabs; otherwise this backend owns a
   * hub of its own and is responsible for closing it.
   */
  private resolveSource(): SseStreamSource {
    if (this.streamSource) return this.streamSource
    this.ownedHub ??= new SseStreamHub({ fetch: this.fetchFn, baseUrl: this.baseUrl })
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

  pushLocalUpdate(bytes: Uint8Array): void | Promise<void> {
    // Through the source, not straight to the daemon, because the source is
    // what knows where this document's authority lives. With no SharedWorker
    // that is the daemon and this is the same POST it always was; with one, the
    // worker's replica merges the bytes against everything else it has seen
    // and writes onward itself. Posting here regardless would write around
    // that replica and re-send state the daemon had just delivered.
    // Returned, not swallowed: `CanvasBackendHandlers` already treats a
    // rejected push as the session's `error` status, and with no worker in
    // front there is nothing else that will ever retry this write.
    return this.resolveSource().push(this.docKey, bytes)
  }

  async getFile(fileId: string): Promise<Blob | null> {
    const res = await this.fetchFn(this.url(canvasFileApiUrl(this.workspaceId, this.slug, fileId)))
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
