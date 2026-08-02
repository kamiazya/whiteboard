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
}

export function DragPreviewLayer({ preview, zoom }: DragPreviewLayerProps) {
  const strokeWidth = 2 / zoom
  const dashArray = `${6 / zoom} ${4 / zoom}`
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
        <line
          x1={preview.from.x}
          y1={preview.from.y}
          x2={preview.to.x}
          y2={preview.to.y}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={dashArray}
          opacity={0.9}
        />
      )}
    </svg>
  )
}
