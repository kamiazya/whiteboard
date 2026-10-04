/**
 * SseBackend: the DocumentBackend every keeper's page syncs through — SSE
 * downstream, ordinary POSTs upstream.
 *
 * The stream is read with `fetch` + `ReadableStream` rather than `EventSource`
 * because a daemon reached through the browser extension is reachable only
 * through the bridge, whose transport is a `fetch`; an `EventSource` or a
 * socket has no way across it. A server-mode keeper
 * authenticates with its session cookie, which a same-origin `fetch` carries
 * too. Reading the body ourselves also works unchanged inside a SharedWorker.
 */

import { apiFetch } from './api-client.js'
import type { DocumentBackend, DocumentBackendHandlers } from './document-backend-contract.js'
import type { DocListener, SseStreamSource } from './sse-stream-hub.js'
import { documentSyncKey, SseStreamHub, workspaceDocKey } from './sse-stream-hub.js'
import { parseServerTextMessage } from './sync-frame-text.js'

export interface SseTransport {
  fetch: typeof globalThis.fetch
}

export class SseBackend implements DocumentBackend {
  private readonly baseUrl: string
  private readonly transport: SseTransport | undefined
  private readonly docKey: string

  private readonly streamSource: SseStreamSource | undefined
  private cancelled = false
  private ownedHub: SseStreamHub | null = null
  private unsubscribe: (() => void) | null = null
  private unsubscribeText: (() => void) | null = null
  /**
   * The key binary frames travel on: always the WORKSPACE document's — the
   * seed snapshot and every update are the workspace record's, and local
   * pushes go to its update route (the per-document binary contract is
   * retired). Text messages (version_created, viewport, restore events)
   * keep flowing on the per-document key — they are addressed per path.
   * The caller scopes its sync session to the open document
   * (`contentDocumentId`), same contract as DaemonBackend.
   */
  private readonly binaryKey: string

  constructor(
    workspaceId: string,
    path: string,
    baseUrl: string,
    transport?: SseTransport,
    streamSource?: SseStreamSource,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.transport = transport
    this.streamSource = streamSource
    this.docKey = documentSyncKey(workspaceId, path)
    this.binaryKey = workspaceDocKey(workspaceId)
  }

  private get fetchFn(): typeof globalThis.fetch {
    return this.transport?.fetch ?? (apiFetch as unknown as typeof globalThis.fetch)
  }

  connect(handlers: DocumentBackendHandlers): void {
    this.cancelled = false
    void this.run(handlers)
  }

  private async run(handlers: DocumentBackendHandlers): Promise<void> {
    // Snapshot first: the stream carries only incremental updates, so a client
    // that started reading before seeding would apply deltas to an empty doc.
    // Through the source, not a direct fetch, for the same reason push is:
    // which authority answers is the implementations' difference. The hub
    // asks the daemon; the
    // worker-backed source asks the worker's replica, so a second tab opens
    // without a daemon round trip and off this thread.
    try {
      const bytes = await this.resolveSource().snapshot(this.binaryKey)
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
    this.unsubscribe = source.subscribe(this.binaryKey, this.binaryListener(handlers))
    // Text messages stay per document — and ONLY text: no binary frame
    // travels on a per-document key.
    this.unsubscribeText = source.subscribe(this.docKey, {
      onUpdate: () => {},
      onMessage: (raw) => this.dispatchText(raw, handlers),
    })
    // No unconditional report here: the source announces its state at
    // subscribe time and on every change, so anything added on top would
    // either overwrite an accurate "not connected yet" or double-report a
    // connection — and the session sends client_ready per report.
  }

  /** What the workspace key's subscription does with each thing the source says. */
  private binaryListener(handlers: DocumentBackendHandlers): DocListener {
    return {
      onUpdate: (bytes) => handlers.onRemoteUpdate(bytes),
      // Nothing addresses text to the workspace key; per-document text
      // arrives on the per-document subscription `run` makes.
      onMessage: () => {},
      // The stream belongs to the source, so its liveness is the only signal
      // this backend has that updates are still arriving.
      onConnectionChange: (connected) => {
        if (this.cancelled) return
        if (connected) handlers.onConnected()
        else handlers.onDisconnected?.()
      },
      // A worker-backed source's push returns before the keeper answers, so
      // this is the only word this page gets that a write failed — and, since
      // the worker retries on its own, that the failure is over.
      onWriteState: (landed) => {
        if (this.cancelled) return
        if (landed) handlers.onWritesLanded?.()
        else handlers.onError?.('storage-failure')
      },
      // A refused credential is the caller's to surface, not this backend's
      // to retry: the source has already stopped reconnecting.
      onAuthRefused: () => {
        if (this.cancelled) return
        handlers.onAuthError?.()
      },
    }
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

  private dispatchText(raw: string, handlers: DocumentBackendHandlers): void {
    // The parser is the one definition of a text frame, so a frame whose type
    // it does not know is dropped there; this switch is exhaustive so a type
    // it does know cannot arrive here without a handler.
    const message = parseServerTextMessage(raw)
    if (message === null) return
    switch (message.type) {
      case 'version_created':
        handlers.onVersionCreated(message.version)
        return
      case 'restore_started':
        handlers.onRestoreStarted(message)
        return
      case 'restore_complete':
        handlers.onRestoreComplete()
        return
      case 'viewport_request':
        handlers.onViewportRequest(message)
        return
      case 'agent_activity':
        handlers.onAgentActivity?.(message)
        return
      default:
        message satisfies never
    }
  }

  disconnect(): void {
    this.cancelled = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.unsubscribeText?.()
    this.unsubscribeText = null
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
    // Returned, not swallowed: `DocumentBackendHandlers` already treats a
    // rejected push as the session's `error` status, and with no worker in
    // front there is nothing else that will ever retry this write.
    return this.resolveSource().push(this.binaryKey, bytes)
  }

  sendClientReady(): void {
    this.resolveSource().sendMessage(this.docKey, { type: 'client_ready' })
  }
}
