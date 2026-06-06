/**
 * CanvasBackend: transport/persistence seam for the canvas editor.
 *
 * The hook owns the LoroDoc lifecycle (fromSnapshot, import, subscribe,
 * UndoManager, applyLoroToExcalidraw). The backend owns only transport:
 * connect/reconnect, raw byte forwarding, file GET/PUT, and typed text dispatch.
 *
 * Payload types for the 6 server events are re-exported from the shared
 * ws-messages.ts module, which derives them from Zod schemas via z.infer.
 * This is the guard against the create_frame interface-vs-z.infer drift class:
 * the types flow from a single Zod source of truth in ws-messages.ts.
 */
import type {
  VersionCreatedPayload,
  RestoreStartedMessage,
  HeadChangedMessage,
  ViewportRequestMessage,
  ExportRequestMessage,
} from '../../shared/ws-messages.js'
import type { BinaryFileData } from '@excalidraw/excalidraw/types'

// ── Server-event payload types re-exported from the Zod SoT ──────────────────
// These types originate from z.infer<> in ws-messages.ts — NOT re-declared here.

export type { VersionCreatedPayload }
export type RestoreStartedPayload = RestoreStartedMessage
export type HeadChangedPayload = HeadChangedMessage
export type ViewportRequestPayload = ViewportRequestMessage
export type ExportRequestPayload = ExportRequestMessage

// ── Inbound callback surface (hook receives from backend) ─────────────────────

export interface CanvasBackendHandlers {
  /** First binary frame from the server: raw Loro snapshot bytes. */
  onSnapshot: (bytes: Uint8Array) => void
  /** Subsequent binary frames: raw Loro incremental-update bytes. */
  onRemoteUpdate: (bytes: Uint8Array) => void
  /** Server auto-saved a new version. */
  onVersionCreated: (payload: VersionCreatedPayload) => void
  /** A peer started a restore; block input and show overlay. */
  onRestoreStarted: (payload: Omit<RestoreStartedPayload, 'type'>) => void
  /** Restore finished; unblock input and clear overlay. */
  onRestoreComplete: () => void
  /** HEAD pointer moved to a different branch. */
  onHeadChanged: (payload: Omit<HeadChangedPayload, 'type'>) => void
  /** Server requests the current viewport. Backend ACKs; hook adjusts view. */
  onViewportRequest: (payload: Omit<ViewportRequestPayload, 'type'>) => void
  /** Server requests a PNG export from this connected client. */
  onExportRequest: (payload: Omit<ExportRequestPayload, 'type'>) => void
  /**
   * Transport (re)connected. Called on every successful open — both the initial
   * connection and every subsequent reconnect after a close/error cycle.
   * The hook uses this to re-send client_ready when the Excalidraw API is
   * already available, so the server adds the reconnected socket to readyConnections
   * and can replay cached viewport requests.
   */
  onConnected: () => void
}

// ── CanvasBackend interface ───────────────────────────────────────────────────

export interface CanvasBackend {
  /**
   * Start the transport (open WebSocket, subscribe to IndexedDB, etc.)
   * and wire the given event handlers. Called on mount / canvas-key change.
   */
  connect(handlers: CanvasBackendHandlers): void

  /**
   * Tear down the transport. Called on unmount / canvas-key change.
   * Must be idempotent.
   */
  disconnect(): void

  /**
   * Send a local Loro update to the server (or persist locally).
   * Called from the hook's doc.subscribeLocalUpdates handler.
   */
  pushLocalUpdate(bytes: Uint8Array): void

  /**
   * Fetch an image file by fileId. Returns the Blob on success, null on miss.
   */
  getFile(fileId: string): Promise<Blob | null>

  /**
   * Upload new image files. Ordering: upload completes before the hook
   * commits the Loro doc, matching the existing commitAfterUpload contract.
   */
  putFile(
    newEntries: [string, BinaryFileData][],
    onFileSuccess: (fileId: string) => void,
  ): Promise<void>

  /** Send client_ready to the server (gated on OPEN state + api present). */
  sendClientReady(): void

  /** Send export_response with the given PNG data for the given requestId. */
  sendExportResponse(requestId: string, data: string): void
}
