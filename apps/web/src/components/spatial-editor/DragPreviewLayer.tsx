/**
 * Presentational overlay for the in-flight gesture preview (move/resize
 * outline, or connect line). Kept out of SpatialEditor.tsx for the same
 * reason as SelectionOverlay.tsx — one focused file per rendered concern.
 * Purely a function of its props; never reads gesture/canvas state itself.
 */
import type { DragPreview } from './drag-preview.js'

export interface DragPreviewLayerProps {
  readonly preview: DragPreview
  /** Current viewport zoom, so stroke width/dash stay a constant on-screen size. */
  readonly zoom: number
  /**
   * The dragged node's own content, rendered ONCE at drag start (a
   * single-node renderCanvasToSvg is ~0.4ms; per-frame motion is a pure
   * CSS transform of this fragment). When present the box preview shows
   * the real node travelling with the pointer instead of a dashed
   * outline — the outline remains as the fallback and for resize.
   */
  readonly contentSvg?: { readonly svg: string; readonly originX: number; readonly originY: number }
}

export function DragPreviewLayer({ preview, zoom, contentSvg }: DragPreviewLayerProps) {
  const strokeWidth = 2 / zoom
  const dashArray = `${6 / zoom} ${4 / zoom}`
  if (preview.kind === 'box' && contentSvg !== undefined) {
    return (
      <div
        data-testid="drag-preview"
        aria-hidden="true"
        // The preview's canvas-space box, exposed for tests: the visual
        // motion is a transform of a pre-rendered fragment, so the box is
        // otherwise not recoverable from the DOM.
        data-box-x={preview.box.x}
        data-box-y={preview.box.y}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          pointerEvents: 'none',
          // The fragment was rendered with the node at its ORIGINAL x/y, so
          // the travel is expressed as a pure translate by the drag delta —
          // the only per-frame cost.
          transform: `translate(${preview.box.x - contentSvg.originX}px, ${preview.box.y - contentSvg.originY}px)`,
          opacity: 0.85,
        }}
        // Same trusted producer as the committed scene: canvas-render's
        // serializer is the sole source of this string (see CanvasViewer's
        // documented reasoning for dangerouslySetInnerHTML).
        // biome-ignore lint/security/noDangerouslySetInnerHtml: same trusted producer as the committed scene — canvas-render's escaping serializer
        dangerouslySetInnerHTML={{ __html: contentSvg.svg }}
      />
    )
  }
  return (
    <svg
      data-testid="drag-preview"
      aria-hidden="true"
      style={{
        position: 'absolute',
        overflow: 'visible',
        left: 0,
        top: 0,
        pointerEvents: 'none',
      }}
    >
      {preview.kind === 'box' ? (
        <rect
          x={preview.box.x}
          y={preview.box.y}
          width={preview.box.width}
          height={preview.box.height}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={dashArray}
          opacity={0.9}
        />
      ) : (
        <>
          <polyline
            points={preview.path.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeDasharray={dashArray}
            opacity={0.9}
          />
          {preview.arrows.map((arrow, i) => (
            <polygon
              // Arrow identity is positional within one preview frame.
              key={i}
              points={arrow.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="currentColor"
              opacity={0.9}
            />
          ))}
        </>
      )}
    </svg>
  )
}
