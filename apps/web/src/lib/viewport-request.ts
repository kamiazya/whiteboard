import type { ViewportRequestPayload } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import type { SpatialEditorHandle } from './spatial/editor-handle.js'
/**
 * Maps a daemon-driven `viewport_request` onto a mounted `SpatialEditor`'s
 * imperative handle. `mode` is optional on the wire
 * (`viewportRequestMessageSchema`), and the browser applies the default for
 * an omitted one: `'move'` when a scroll offset or zoom arrives with no
 * `elementIds`, `'fit'` otherwise. A caller who names a position or a zoom
 * means to go there, and an unannounced `fit` would drop those fields on the
 * floor while the tool reported delivery; `elementIds` only mean anything to
 * `fit`, so naming them keeps it. `mode: 'fit'` (optionally scoped by
 * `elementIds`) routes to `fitToContent`; `mode: 'move'` routes to
 * `setViewport`.
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
  const mode = payload.mode ?? defaultMode(payload)
  if (mode === 'fit') {
    handle.fitToContent(payload.elementIds)
    return
  }
  handle.setViewport({
    x: payload.scrollX ?? 0,
    y: payload.scrollY ?? 0,
    zoom: payload.zoom ?? 1,
  })
}

function defaultMode(payload: Omit<ViewportRequestPayload, 'type'>): 'fit' | 'move' {
  const positioned =
    payload.scrollX !== undefined || payload.scrollY !== undefined || payload.zoom !== undefined
  return positioned && payload.elementIds === undefined ? 'move' : 'fit'
}
