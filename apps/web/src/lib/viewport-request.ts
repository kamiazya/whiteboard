import type { ViewportRequestPayload } from '@kamiazya/whiteboard-mcp/browser-contract'
import type { SpatialEditorHandle } from '../components/spatial-editor/index.js'

/**
 * Maps a daemon-driven `viewport_request` onto a mounted `SpatialEditor`'s
 * imperative handle. `mode: 'fit'` (optionally scoped by `elementIds`) routes
 * to `fitToContent`; `mode: 'move'` or an absent mode routes to `setViewport`.
 *
 * The wire payload is Excalidraw-shaped (a scene scroll offset + a scalar
 * zoom) from when the daemon's only client was Excalidraw; this maps it
 * directly onto `SpatialEditor`'s own `{x, y, zoom}` viewport with no sign
 * flip — a deliberate simplification for this cutover, not a preserved
 * Excalidraw contract. A missing scroll/zoom field falls back to the
 * identity viewport (0, 0, 1) rather than to some previously-observed
 * viewport, keeping this function pure and total.
 *
 * A `null` handle (no editor mounted) is a no-op, matching the rest of this
 * session's degrade-rather-than-throw callback convention.
 */
export function applyViewportRequest(
  payload: Omit<ViewportRequestPayload, 'type'>,
  handle: SpatialEditorHandle | null,
): void {
  if (handle === null) return
  if (payload.mode === 'fit') {
    handle.fitToContent(payload.elementIds)
    return
  }
  handle.setViewport({
    x: payload.scrollX ?? 0,
    y: payload.scrollY ?? 0,
    zoom: payload.zoom ?? 1,
  })
}
