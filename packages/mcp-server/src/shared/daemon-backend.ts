/**
 * DaemonBackend: the WebSocket + apiFetch transport for the canvas editor.
 *
 * Ownership split:
 * - DaemonBackend owns: WS create/reconnect/backoff/send, binaryType,
 *   onopen attempt-reset, onclose exponential backoff, onerror force-close,
 *   apiFetch file GET, uploadFiles file PUT, text-message dispatch.
 * - The hook owns: LoroDoc lifecycle, UndoManager, subscribeLocalUpdates,
 *   doc.subscribe, applyLoroToExcalidraw, filesCache, CustomEvent dispatch.
 *
 * DaemonBackend constructs `new WebSocket(...)` itself (no injected factory)
 * so useWhiteboardSync.reconnect.test.tsx, which swaps globalThis.WebSocket
 * and asserts exact instance counts + 500/1000/2000/4000/8000 backoff,
 * continues to pass unmodified.
 *
 * snapshotReceived is an instance field, not a per-openSocket local, so a
 * reconnect does not reset it. After the initial snapshot is received, every
 * subsequent binary frame — including the first frame on a reconnected socket
 * — routes to onRemoteUpdate (import/merge) rather than onSnapshot (replace).
 * Replacing the LoroDoc on reconnect would destroy local unsynced edits and
 * UndoManager history.
 */

import { apiFetch } from './api-client.js'
import { canvasFileApiUrl } from './api-contracts/canvas-url.js'
import type {
  BinaryFileDataLike,
  CanvasBackend,
  CanvasBackendHandlers,
} from './canvas-backend-contract.js'
import { readDaemonTokenOnce } from './token-store.js'
import { uploadFiles } from './upload-files.js'
import {
  clientReadyMessageSchema,
  exportResponseMessageSchema,
  viewportResponseMessageSchema,
} from './ws-messages.js'
import { buildWhiteboardWsProtocols, buildWhiteboardWsUrl } from './ws-protocol.js'
import { parseServerTextMessage } from './ws-text-message.js'

/**
 * Cross-origin transport override for getFile/putFile. The module-level
 * apiFetch only resolves relative /api/... paths against the current page
 * origin, so a daemon paired from a different origin (apps/web talking to a
 * loopback daemon) needs its own fetch that targets the daemon's origin.
 */
export interface DaemonApiTransport {
  fetch: typeof globalThis.fetch
  /**
   * WS upgrade credential for a paired session. The server accepts an
   * origin-scoped pairing session token through the same `daemon-token.`
   * subprotocol as the shared daemon token (ws-auth.ts validates it against
   * the upgrade's Origin), but that token lives in page memory — never in
   * the `#wb=` bootstrap global readDaemonTokenOnce() reads. Without this,
   * a pairing-grant session offers no credential at all and every upgrade
   * is rejected 401 while the HTTP side keeps working. A function so a
   * rotated session token is re-read on every reconnect attempt; the
   * bootstrap global, when seeded, still wins.
   */
  wsToken?: () => string | undefined
}

// Browsers surface a WS handshake rejection (e.g. HTTP 401 on the upgrade
// request from a wrong/expired daemon token) as close code 1006, not 1008 —
// the 1008 (Policy Violation) branch below only fires when the server itself
// accepts the upgrade and then closes the application-level socket. A
// consecutive run of sockets that never fire onopen is the only client-side
// signal available for "this token cannot ever succeed"; retrying it forever
// would silently spam reconnects with no way for the user to recover.
const MAX_CONSECUTIVE_IMMEDIATE_FAILURES = 3

export class DaemonBackend implements CanvasBackend {
  private readonly workspaceId: string
  private readonly path: string
  private readonly locationHref: string
  private readonly apiTransport: DaemonApiTransport | undefined

  private ws: WebSocket | null = null
  private cancelled = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  // Counts consecutive closes of a socket that never reached onopen. Reset to
  // 0 whenever a socket opens, so a connection that flapped after actually
  // connecting never trips the cap — only an unbroken run of immediate
  // rejections does.
  private consecutiveImmediateFailures = 0
  // Hoisted to instance scope so reconnects do not reset it. Only reset by
  // disconnect() or when the canvas (workspaceId/path) changes via a new
  // connect() call after the hook tears down the previous backend.
  private snapshotReceived = false

  constructor(
    workspaceId: string,
    path: string,
    locationHref: string,
    apiTransport?: DaemonApiTransport,
  ) {
    this.workspaceId = workspaceId
    this.path = path
    this.locationHref = locationHref
    this.apiTransport = apiTransport
  }

  connect(handlers: CanvasBackendHandlers): void {
    this.cancelled = false
    this.attempt = 0
    this.consecutiveImmediateFailures = 0
    this.openSocket(handlers)
  }

  disconnect(): void {
    this.cancelled = true
    this.snapshotReceived = false
    this.consecutiveImmediateFailures = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
  }

  pushLocalUpdate(bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(bytes.slice())
  }

  async getFile(fileId: string): Promise<Blob | null> {
    const fetchFn = this.apiTransport?.fetch ?? apiFetch
    const res = await fetchFn(canvasFileApiUrl(this.workspaceId, this.path, fileId))
    if (!res.ok) return null
    return res.blob()
  }

  async putFile(
    newEntries: [string, BinaryFileDataLike][],
    onFileSuccess: (fileId: string) => void,
  ): Promise<void> {
    await uploadFiles(
      newEntries,
      this.workspaceId,
      this.path,
      onFileSuccess,
      this.apiTransport?.fetch,
    )
  }

  sendClientReady(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const msg = clientReadyMessageSchema.parse({ type: 'client_ready' })
    ws.send(JSON.stringify(msg))
  }

  sendExportResponse(requestId: string, data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const msg = exportResponseMessageSchema.parse({
      type: 'export_response',
      requestId,
      data,
    })
    this.ws.send(JSON.stringify(msg))
  }

  private openSocket(handlers: CanvasBackendHandlers): void {
    if (this.cancelled) return

    const daemonToken = readDaemonTokenOnce() ?? this.apiTransport?.wsToken?.() ?? null

    const ws = new WebSocket(
      buildWhiteboardWsUrl(this.locationHref, this.workspaceId, this.path),
      buildWhiteboardWsProtocols(daemonToken),
    )
    // Required: without this, binary frames arrive as Blob and the ArrayBuffer
    // check in the message handler fails.
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    let opened = false

    ws.onopen = () => {
      opened = true
      this.attempt = 0
      this.consecutiveImmediateFailures = 0
      handlers.onConnected()
    }

    ws.onclose = (event: CloseEvent) => {
      if (this.cancelled) return
      // Reported before the terminal branches below so a caller learns the
      // socket is gone even when the backend gives up on reconnecting.
      handlers.onDisconnected?.()
      // 1008 = Policy Violation: server rejected the connection due to auth failure.
      // 1003 = Unsupported Data: the server could not decode a binary frame we
      // sent (see routes/ws.ts). Both are terminal from the client's
      // perspective — reconnecting with the same token, or replaying the same
      // buggy payload, would just reproduce the same close indefinitely.
      if (event.code === 1008 || event.code === 1003) {
        handlers.onAuthError?.()
        return
      }
      if (!opened) {
        this.consecutiveImmediateFailures += 1
        if (this.consecutiveImmediateFailures >= MAX_CONSECUTIVE_IMMEDIATE_FAILURES) {
          handlers.onAuthError?.()
          return
        }
      }
      // 500ms, 1s, 2s, 4s, 8s, 8s, … capped at 8s.
      const delay = Math.min(8000, 500 * 2 ** this.attempt)
      this.attempt += 1
      this.reconnectTimer = setTimeout(() => {
        this.openSocket(handlers)
      }, delay)
    }

    ws.onerror = () => {
      // Browsers usually also fire close here, but force it just in case so
      // reconnect logic runs.
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data)
        if (!this.snapshotReceived) {
          this.snapshotReceived = true
          handlers.onSnapshot(bytes)
        } else {
          handlers.onRemoteUpdate(bytes)
        }
        return
      }

      if (typeof event.data === 'string') {
        const msg = parseServerTextMessage(event.data)
        if (!msg) return

        if (msg.type === 'version_created') {
          handlers.onVersionCreated(msg.version)
          return
        }
        if (msg.type === 'restore_started') {
          handlers.onRestoreStarted({ label: msg.label })
          return
        }
        if (msg.type === 'restore_complete') {
          handlers.onRestoreComplete()
          return
        }
        if (msg.type === 'head_changed') {
          handlers.onHeadChanged({ head: msg.head })
          return
        }
        if (msg.type === 'viewport_request') {
          handlers.onViewportRequest({
            requestId: msg.requestId,
            mode: msg.mode,
            elementIds: msg.elementIds,
            animate: msg.animate,
            scrollX: msg.scrollX,
            scrollY: msg.scrollY,
            zoom: msg.zoom,
          })
          // ACK always goes on the same socket captured in this message closure,
          // not via this.ws, so concurrent reconnects do not mis-route the ACK.
          ws.send(
            JSON.stringify(
              viewportResponseMessageSchema.parse({
                type: 'viewport_response',
                requestId: msg.requestId,
              }),
            ),
          )
          return
        }
        if (msg.type === 'export_request') {
          handlers.onExportRequest({
            requestId: msg.requestId,
            padding: msg.padding,
            scale: msg.scale,
            minFontPx: msg.minFontPx,
            frameId: msg.frameId,
            theme: msg.theme,
          })
        }
      }
    }
  }
}
