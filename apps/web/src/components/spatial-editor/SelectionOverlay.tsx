/** Selection outline + resize handles + in-flight connect line, drawn in canvas space. */
import type { Box, ResizeHandleKind } from './geometry.js'
import { resizeHandleBoxes } from './geometry.js'

export interface SelectionOverlayProps {
  readonly box: Box
  readonly zoom: number
  readonly onHandlePointerDown: (handle: ResizeHandleKind, box: Box, e: React.PointerEvent) => void
  readonly onConnectPointerDown: (e: React.PointerEvent) => void
}

const SELECTION_STROKE = '#2563eb'

export function SelectionOverlay({
  box,
  zoom,
  onHandlePointerDown,
  onConnectPointerDown,
}: SelectionOverlayProps) {
  const handles = resizeHandleBoxes(box, zoom)
  const connectHandleSize = 10 / zoom
  return (
    <svg
      data-testid="selection-overlay"
      role="img"
      aria-label="Selection outline and resize/connect handles"
      style={{ position: 'absolute', overflow: 'visible', left: 0, top: 0, pointerEvents: 'none' }}
    >
      <title>Selection outline and resize/connect handles</title>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        fill="none"
        stroke={SELECTION_STROKE}
        strokeWidth={1 / zoom}
        pointerEvents="none"
      />
      {handles.map((handle) => (
        <rect
          key={handle.kind}
          data-testid={`resize-handle-${handle.kind}`}
          x={handle.box.x}
          y={handle.box.y}
          width={handle.box.width}
          height={handle.box.height}
          fill="#fff"
          stroke={SELECTION_STROKE}
          strokeWidth={1 / zoom}
          style={{ pointerEvents: 'auto', cursor: `${handle.kind}-resize` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            onHandlePointerDown(handle.kind, handle.box, e)
          }}
        />
      ))}
      <circle
        data-testid="connect-handle"
        cx={box.x + box.width + connectHandleSize}
        cy={box.y + box.height / 2}
        r={connectHandleSize / 2}
        fill={SELECTION_STROKE}
        style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
        onPointerDown={(e) => {
          e.stopPropagation()
          onConnectPointerDown(e)
        }}
      />
    </svg>
  )
}
