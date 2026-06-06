/**
 * DaemonBackend: the current WebSocket + apiFetch transport, extracted from
 * useWhiteboardSync. Behavior is byte-for-byte identical to the inline WS
 * code that previously lived in the hook.
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
 */
import { apiFetch } from './api-client.js'
import { uploadFiles } from './upload-files.js'
import {
  buildWhiteboardWsUrl,
  buildWhiteboardWsProtocols,
} from '../hooks/useWhiteboardSync.helpers.js'
import { parseServerTextMessage } from '../hooks/useWhiteboardSync.text-message.js'
import type { CanvasBackend, CanvasBackendHandlers } from './canvas-backend.js'
import type { BinaryFileData } from '@excalidraw/excalidraw/types'

export class DaemonBackend implements CanvasBackend {
  private readonly workspaceId: string
  private readonly slug: string
  private readonly locationHref: string

  private ws: WebSocket | null = null
  private cancelled = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0

  constructor(workspaceId: string, slug: string, locationHref: string) {
    this.workspaceId = workspaceId
    this.slug = slug
    this.locationHref = locationHref
  }

  connect(handlers: CanvasBackendHandlers): void {
    this.cancelled = false
    this.attempt = 0
    this.openSocket(handlers)
  }

  disconnect(): void {
    this.cancelled = true
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
    this.ws?.send(bytes.slice())
  }

  async getFile(fileId: string): Promise<Blob | null> {
    const res = await apiFetch(
      `/api/canvas/${this.workspaceId}/${encodeURIComponent(this.slug)}/file/${fileId}`,
    )
    if (!res.ok) return null
    return res.blob()
  }

  async putFile(
    newEntries: [string, BinaryFileData][],
    onFileSuccess: (fileId: string) => void,
  ): Promise<void> {
    await uploadFiles(newEntries, this.workspaceId, this.slug, onFileSuccess)
  }

  sendClientReady(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'client_ready' }))
  }

  sendViewportResponse(requestId: string): void {
    this.ws?.send(JSON.stringify({ type: 'viewport_response', requestId }))
  }

  sendExportResponse(requestId: string, data: string): void {
    this.ws?.send(JSON.stringify({ type: 'export_response', requestId, data }))
  }

  private openSocket(handlers: CanvasBackendHandlers): void {
    if (this.cancelled) return

    const daemonToken =
      typeof window !== 'undefined'
        ? (window.__WHITEBOARD_RUNTIME_CONFIG__?.daemonToken ?? null)
        : null

    const ws = new WebSocket(
      buildWhiteboardWsUrl(this.locationHref, this.workspaceId, this.slug),
      buildWhiteboardWsProtocols(daemonToken),
    )
    // Required: without this, binary frames arrive as Blob and the ArrayBuffer
    // check in the message handler fails.
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    let snapshotReceived = false

    ws.onopen = () => {
      this.attempt = 0
    }

    ws.onclose = () => {
      if (this.cancelled) return
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
        if (!snapshotReceived) {
          snapshotReceived = true
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
            JSON.stringify({ type: 'viewport_response', requestId: msg.requestId }),
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
