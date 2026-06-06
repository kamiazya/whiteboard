/**
 * CanvasBackend: transport/persistence seam for the canvas editor.
 *
 * This module lives in src/shared so it is included in the tsconfig.server.json
 * declaration emit (dist/shared/canvas-backend-contract.d.ts) and can be
 * exported from the package via a subpath without pulling JSX-heavy src/app
 * into the Node build.
 *
 * CanvasBackend and CanvasBackendHandlers are intentionally hand-written
 * `interface` declarations — they are a pure in-process callback/transport
 * seam (methods + on* callbacks), NOT a JSON shape that crosses a process
 * boundary. The zod-schema-discipline rule governs cross-boundary JSON
 * payloads; the payload field types used here flow from z.infer<> in
 * ws-messages.ts, so there is no parallel re-declaration of those shapes.
 */

// ── Payload types re-exported from the Zod SoT ───────────────────────────────
// All payload types originate from z.infer<> in ws-messages.ts.
export type {
  VersionCreatedPayload,
  RestoreStartedMessage,
  HeadChangedMessage,
  ViewportRequestMessage,
  ExportRequestMessage,
  ServerTextMessage,
  ClientTextMessage,
} from './ws-messages.js'

export {
  versionCreatedMessageSchema,
  headChangedMessageSchema,
  restoreStartedMessageSchema,
  restoreCompleteMessageSchema,
  viewportRequestMessageSchema,
  exportRequestMessageSchema,
  serverTextMessageSchema,
  clientReadyMessageSchema,
  exportResponseMessageSchema,
  viewportResponseMessageSchema,
  clientTextMessageSchema,
} from './ws-messages.js'

// ── Inbound callback surface (hook receives from backend) ─────────────────────

import type {
  VersionCreatedPayload,
  RestoreStartedMessage,
  HeadChangedMessage,
  ViewportRequestMessage,
  ExportRequestMessage,
} from './ws-messages.js'

export type RestoreStartedPayload = RestoreStartedMessage
export type HeadChangedPayload = HeadChangedMessage
export type ViewportRequestPayload = ViewportRequestMessage
export type ExportRequestPayload = ExportRequestMessage

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
    newEntries: [string, BinaryFileDataLike][],
    onFileSuccess: (fileId: string) => void,
  ): Promise<void>

  /** Send client_ready to the server (gated on OPEN state + api present). */
  sendClientReady(): void

  /** Send export_response with the given PNG data for the given requestId. */
  sendExportResponse(requestId: string, data: string): void
}

/**
 * Minimal structural type for image file data passed to putFile.
 * Avoids importing from @excalidraw/excalidraw/types in this shared module
 * (which would pull browser-only types into the Node declaration build).
 * Implementors that use Excalidraw's BinaryFileData satisfy this shape.
 */
export interface BinaryFileDataLike {
  mimeType: string
  id: string
  dataURL: string
  created: number
  lastRetrieved?: number
}
