/** Selection outline + resize handles + in-flight connect line, drawn in canvas space. */
import type { Box, ResizeHandleKind } from './geometry.js'
import { cornerHitBoxes, edgeBandBoxes, resizeHandleBoxes } from './geometry.js'

export interface SelectionOverlayProps {
  readonly box: Box
  readonly zoom: number
  /**
   * Handle/connect pointerdowns stop propagation before these fire, so the
   * root's own empty-space hit-test never also sees them.
   */
  readonly onHandlePointerDown: (handle: ResizeHandleKind, box: Box, e: React.PointerEvent) => void
  /**
   * Absent while several nodes are selected. Connecting acts on ONE node, and
   * offering it from handles that surround a group would claim the action
   * applies to all of them.
   */
  readonly onConnectPointerDown?: (e: React.PointerEvent) => void
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

const SELECTION_STROKE = 'var(--manipulation)'
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
  // Hitting and drawing are separate questions: the markers stay 8px so
  // small nodes are not swallowed, while the transparent hit shapes below
  // meet WCAG 2.5.8's 24px floor — 32px where the pointer is a finger
  // (matchMedia is cheap and correct here; a resize re-render re-reads it).
  const hitPx =
    typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 32 : 24
  const cornerHits = cornerHitBoxes(box, zoom, hitPx)
  const edgeBands = edgeBandBoxes(box, zoom, hitPx / 2, hitPx)
  const connectHandleSize = 10 / zoom
  const connectHitRadius = hitPx / 2 / zoom
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
        data-testid="selection-outline"
        aria-hidden="true"
        // SVG shape elements can be natively focusable in some browsers even
        // without an explicit tabIndex; tabIndex={-1} keeps this decorative
        // outline out of the tab order to match its aria-hidden intent.
        tabIndex={-1}
        // Draws itself once and stops (BRAND.md motion grammar). pathLength
        // normalises the perimeter so the keyframes need no measurements;
        // the caller remounts this component per selection TARGET, which is
        // what replays the draw for a new selection but not per drag frame.
        pathLength={100}
        className="selection-draw"
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        fill="none"
        stroke={SELECTION_STROKE}
        strokeWidth={1 / zoom}
        pointerEvents="none"
      />
      {/* Paint order IS the hit priority: edge bands at the bottom, corner
          hits above them, connect hits last of all — so a press near a
          corner is a corner, and the connect port outside the edge is never
          shadowed by the band under it. */}
      {edgeBands.map((band) => (
        // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this canvas-space box under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
        <rect
          key={band.kind}
          data-testid={`resize-handle-${band.kind}`}
          role="button"
          tabIndex={0}
          aria-label={HANDLE_LABEL[band.kind]}
          x={band.box.x}
          y={band.box.y}
          width={band.box.width}
          height={band.box.height}
          fill="transparent"
          // Same legibility rule as .connect-hit: the band has no resting
          // marker at all, so hover/focus paints the halo to say "this is
          // grabbable" before anything is committed to.
          className="resize-hit"
          style={{ pointerEvents: 'auto', cursor: `${band.kind}-resize` }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            onHandlePointerDown(band.kind, band.box, e)
          }}
          onKeyDown={(e) => {
            if (onHandleKeyDown === undefined || !ARROW_KEYS.has(e.key)) return
            e.stopPropagation()
            onHandleKeyDown(band.kind, band.box, e)
          }}
        />
      ))}
      {cornerHits.map((hit) => (
        // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this canvas-space box under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
        <rect
          key={hit.kind}
          data-testid={`resize-handle-${hit.kind}`}
          role="button"
          tabIndex={0}
          aria-label={HANDLE_LABEL[hit.kind]}
          x={hit.box.x}
          y={hit.box.y}
          width={hit.box.width}
          height={hit.box.height}
          fill="transparent"
          className="resize-hit"
          style={{ pointerEvents: 'auto', cursor: `${hit.kind}-resize` }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            onHandlePointerDown(hit.kind, hit.box, e)
          }}
          onKeyDown={(e) => {
            if (onHandleKeyDown === undefined || !ARROW_KEYS.has(e.key)) return
            // Fully handled here — without this the root's own arrow handler
            // would ALSO nudge the node, double-applying every keypress.
            e.stopPropagation()
            onHandleKeyDown(hit.kind, hit.box, e)
          }}
        />
      ))}
      {handles.map((handle) => (
        <rect
          key={`marker-${handle.kind}`}
          aria-hidden="true"
          // Same reason as the outline: SVG shapes can be natively focusable
          // in some browsers, and aria-hidden on a focusable is a trap.
          tabIndex={-1}
          x={handle.box.x}
          y={handle.box.y}
          width={handle.box.width}
          height={handle.box.height}
          fill="var(--background)"
          stroke={SELECTION_STROKE}
          strokeWidth={1 / zoom}
          pointerEvents="none"
        />
      ))}
      {onConnectPointerDown !== undefined &&
        CONNECT_SIDES.map((side) => (
          <g key={side.kind}>
            <circle
              aria-hidden="true"
              tabIndex={-1}
              cx={side.cx(box, connectHandleSize)}
              cy={side.cy(box, connectHandleSize)}
              r={connectHandleSize / 2}
              fill={SELECTION_STROKE}
              pointerEvents="none"
            />
            {/* biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this canvas-space position under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand. */}
            <circle
              data-testid={side.kind === 'e' ? 'connect-handle' : `connect-handle-${side.kind}`}
              role="button"
              tabIndex={0}
              aria-label={`Connect to another node (from the ${side.label} side)`}
              cx={side.cx(box, connectHandleSize)}
              cy={side.cy(box, connectHandleSize)}
              r={connectHitRadius}
              fill="transparent"
              // The halo makes the invisible target legible the moment it is
              // hovered or focused — see index.css's --manipulation-halo.
              className="connect-hit"
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
          </g>
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
            fill="var(--background)"
            style={{ userSelect: 'none' }}
          >
            ✎
          </text>
        </g>
      )}
    </svg>
  )
}
