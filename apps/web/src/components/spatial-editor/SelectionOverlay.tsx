/** Selection outline + resize handles + in-flight connect line, drawn in canvas space. */
import type { Box, ResizeHandleKind } from './geometry.js'
import { resizeHandleBoxes } from './geometry.js'

export interface SelectionOverlayProps {
  readonly box: Box
  readonly zoom: number
  /**
   * Handle/connect pointerdowns stop propagation before these fire, so the
   * root's own empty-space hit-test never also sees them.
   */
  readonly onHandlePointerDown: (handle: ResizeHandleKind, box: Box, e: React.PointerEvent) => void
  readonly onConnectPointerDown: (e: React.PointerEvent) => void
  /** Arrow-key nudge on a focused resize handle — the keyboard equivalent of a pointer drag. */
  readonly onHandleKeyDown?: (handle: ResizeHandleKind, box: Box, e: React.KeyboardEvent) => void
  /** Enter/Space on the focused connect handle — the keyboard equivalent of a pointer connect-drag. */
  readonly onConnectKeyDown?: (e: React.KeyboardEvent) => void
}

const SELECTION_STROKE = '#2563eb'
const HANDLE_LABEL: Record<ResizeHandleKind, string> = {
  nw: 'Resize north-west',
  n: 'Resize north',
  ne: 'Resize north-east',
  e: 'Resize east',
  se: 'Resize south-east',
  s: 'Resize south',
  sw: 'Resize south-west',
  w: 'Resize west',
}
const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

export function SelectionOverlay({
  box,
  zoom,
  onHandlePointerDown,
  onConnectPointerDown,
  onHandleKeyDown,
  onConnectKeyDown,
}: SelectionOverlayProps) {
  const handles = resizeHandleBoxes(box, zoom)
  const connectHandleSize = 10 / zoom
  return (
    <svg
      data-testid="selection-overlay"
      style={{ position: 'absolute', overflow: 'visible', left: 0, top: 0, pointerEvents: 'none' }}
    >
      {/* Named rather than aria-hidden: this subtree holds the focusable resize
          and connect controls, so hiding it would undo their keyboard path. */}
      <title>Selection controls</title>
      {/* Purely visual chrome — the interactive controls below carry their own role/label. */}
      <rect
        aria-hidden="true"
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
          role="button"
          tabIndex={0}
          aria-label={HANDLE_LABEL[handle.kind]}
          x={handle.box.x}
          y={handle.box.y}
          width={handle.box.width}
          height={handle.box.height}
          fill="#fff"
          stroke={SELECTION_STROKE}
          strokeWidth={1 / zoom}
          style={{ pointerEvents: 'auto', cursor: `${handle.kind}-resize` }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            onHandlePointerDown(handle.kind, handle.box, e)
          }}
          onKeyDown={(e) => {
            if (onHandleKeyDown === undefined || !ARROW_KEYS.has(e.key)) return
            onHandleKeyDown(handle.kind, handle.box, e)
          }}
        />
      ))}
      <circle
        data-testid="connect-handle"
        role="button"
        tabIndex={0}
        aria-label="Connect to another node"
        cx={box.x + box.width + connectHandleSize}
        cy={box.y + box.height / 2}
        r={connectHandleSize / 2}
        fill={SELECTION_STROKE}
        style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.stopPropagation()
          onConnectPointerDown(e)
        }}
        onKeyDown={(e) => {
          if (onConnectKeyDown === undefined || (e.key !== 'Enter' && e.key !== ' ')) return
          onConnectKeyDown(e)
        }}
      />
    </svg>
  )
}
