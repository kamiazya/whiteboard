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
  /**
   * Opens the selected node's text editor. Rendered only when provided
   * (non-text nodes have no text to edit). Fired on CLICK, not pointerdown:
   * the editor mount (autofocus included) flushes synchronously inside a
   * discrete event, and mousedown's default focus action would then blur
   * the just-mounted textarea and instantly close it — the same fight the
   * double-press path suppresses with preventDefault. Click fires after
   * those defaults, so it needs no suppression at all.
   */
  readonly onEditRequest?: () => void
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

/**
 * One connect handle per side. Every handle starts the SAME connecting
 * gesture — the committed edge's path is routed from geometry at layout
 * time, so the chosen side is ergonomic freedom, not persisted data. The
 * right handle keeps the historical un-suffixed testid.
 */
type SideSpec = {
  readonly kind: 'n' | 'e' | 's' | 'w'
  readonly label: string
  readonly cx: (box: Box, size: number) => number
  readonly cy: (box: Box, size: number) => number
}
const CONNECT_SIDES: readonly SideSpec[] = [
  { kind: 'n', label: 'top', cx: (b) => b.x + b.width / 2, cy: (b, s) => b.y - s },
  { kind: 'e', label: 'right', cx: (b, s) => b.x + b.width + s, cy: (b) => b.y + b.height / 2 },
  { kind: 's', label: 'bottom', cx: (b) => b.x + b.width / 2, cy: (b, s) => b.y + b.height + s },
  { kind: 'w', label: 'left', cx: (b, s) => b.x - s, cy: (b) => b.y + b.height / 2 },
]

export function SelectionOverlay({
  box,
  zoom,
  onHandlePointerDown,
  onConnectPointerDown,
  onHandleKeyDown,
  onConnectKeyDown,
  onEditRequest,
}: SelectionOverlayProps) {
  const handles = resizeHandleBoxes(box, zoom)
  const connectHandleSize = 10 / zoom
  return (
    <svg
      data-testid="selection-overlay"
      style={{ position: 'absolute', overflow: 'visible', left: 0, top: 0, pointerEvents: 'none' }}
    >
      <title>Selection controls</title>
      {/* Named rather than aria-hidden: this subtree holds the focusable resize
          and connect controls, so hiding it would undo their keyboard path. */}
      {/* Purely visual chrome — the interactive controls below carry their own role/label. */}
      <rect
        aria-hidden="true"
        // SVG shape elements can be natively focusable in some browsers even
        // without an explicit tabIndex; tabIndex={-1} keeps this decorative
        // outline out of the tab order to match its aria-hidden intent.
        tabIndex={-1}
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
        // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this handle's canvas-space box under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
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
            // Fully handled here — without this the root's own arrow handler
            // would ALSO nudge the node, double-applying every keypress.
            e.stopPropagation()
            onHandleKeyDown(handle.kind, handle.box, e)
          }}
        />
      ))}
      {CONNECT_SIDES.map((side) => (
        // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this canvas-space position under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
        <circle
          key={side.kind}
          data-testid={side.kind === 'e' ? 'connect-handle' : `connect-handle-${side.kind}`}
          role="button"
          tabIndex={0}
          aria-label={`Connect to another node (from the ${side.label} side)`}
          cx={side.cx(box, connectHandleSize)}
          cy={side.cy(box, connectHandleSize)}
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
      ))}
      {onEditRequest !== undefined && (
        // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this canvas-space position under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
        <g
          data-testid="edit-handle"
          role="button"
          tabIndex={0}
          aria-label="Edit text"
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onPointerDown={(e) => {
            // Keep the press away from the root's node/empty hit-test; the
            // action itself fires on click (see onEditRequest's doc).
            e.stopPropagation()
          }}
          onClick={() => onEditRequest()}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            onEditRequest()
          }}
        >
          <rect
            x={box.x + box.width - 22 / zoom}
            y={box.y - 26 / zoom}
            width={22 / zoom}
            height={20 / zoom}
            rx={4 / zoom}
            fill={SELECTION_STROKE}
          />
          <text
            x={box.x + box.width - 11 / zoom}
            y={box.y - 12 / zoom}
            textAnchor="middle"
            fontSize={12 / zoom}
            fill="#ffffff"
            style={{ userSelect: 'none' }}
          >
            ✎
          </text>
        </g>
      )}
    </svg>
  )
}
