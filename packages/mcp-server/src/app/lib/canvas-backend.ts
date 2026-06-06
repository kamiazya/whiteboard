/**
 * CanvasBackend: transport/persistence seam for the canvas editor.
 *
 * The hook owns the LoroDoc lifecycle (fromSnapshot, import, subscribe,
 * UndoManager, applyLoroToExcalidraw). The backend owns only transport:
 * connect/reconnect, raw byte forwarding, file GET/PUT, and typed text dispatch.
 *
 * CanvasBackend, CanvasBackendHandlers, and the server-event payload types are
 * defined once in the shared contract module and re-exported here so that
 * DaemonBackend and useWhiteboardSync use the exact same types as the public
 * ./browser-contract subpath export — no parallel re-declaration.
 */

// ── Single source of truth: re-export from shared contract ───────────────────
// Type-only imports: zero runtime cost, zero bundle impact.
export type {
  BinaryFileDataLike,
  CanvasBackend,
  CanvasBackendHandlers,
  ExportRequestPayload,
  HeadChangedPayload,
  RestoreStartedPayload,
  VersionCreatedPayload,
  ViewportRequestPayload,
} from '../../shared/canvas-backend-contract.js'
