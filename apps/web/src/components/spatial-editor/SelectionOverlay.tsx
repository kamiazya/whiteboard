/** Selection outline + resize handles + in-flight connect line, drawn in canvas space. */
import type { Box, ResizeHandleKind } from './geometry.js'
import { cornerHitBoxes, edgeBandBoxes, resizeHandleBoxes } from './geometry.js'
import type { Point } from './viewport.js'

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
   * Opens the object's action menu, anchored at the control. Offered for
   * every selection (multi included). Fired on POINTERUP, not click: the
   * editor root preventDefaults native touchstart (its iOS long-press
   * suppression), which cancels the synthetic mouse-compatibility events,
   * so a touch tap never produces a click here — and pointerup still lands
   * after mousedown's default focus action, so a menu action that mounts
   * an editor has no focus fight to lose.
   */
  readonly onMoreActions?: (anchor: Point) => void
  /**
   * Opens this node's body on a fuller editing surface.
   *
   * A DOORWAY, not a verb: every entry in the ⋯ catalog changes the node and
   * leaves you on the canvas, and this one changes nothing and moves you
   * somewhere else. Putting a navigation among object verbs is what left two
   * near-identical pencil icons side by side with no way to tell them apart.
   */
  readonly onOpenInEditor?: () => void
}

const SELECTION_STROKE = 'var(--manipulation)'

/**
 * The node-tools pill is drawn in the app's neutral ink, not the manipulation
 * accent. The accent is what says "this is selected", and it is already spent
 * on the outline and the handles — repeating it on a control that sits beside
 * the node makes the loudest thing on the canvas a piece of chrome. Both
 * carry a literal fallback because this overlay must render the same where
 * the app stylesheet is absent (browser-mode component tests).
 */
const TOOL_INK = 'var(--muted-foreground, oklch(0.556 0 0))'
const TOOL_EDGE = 'var(--border, oklch(0.922 0 0))'
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
  onMoreActions,
  onOpenInEditor,
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
      {(onOpenInEditor !== undefined || onMoreActions !== undefined) &&
        (() => {
          // ONE group, not one chip per verb. The two doorways stay separate
          // controls — they lead to different kinds of place — but they read
          // as a single tool cluster attached to this node, and they are
          // drawn quietly: the selection outline already says "this is
          // selected", so a solid accent fill here would be the loudest thing
          // on a canvas whose job is to recede behind its content.
          const slots = [
            ...(onOpenInEditor === undefined
              ? []
              : [{ kind: 'open' as const, label: 'Open in editor', run: onOpenInEditor }]),
            ...(onMoreActions === undefined
              ? []
              : [
                  {
                    kind: 'more' as const,
                    label: 'More actions',
                    run: () =>
                      onMoreActions({
                        x: box.x + box.width - 12 / zoom,
                        y: box.y - 18 / zoom,
                      }),
                  },
                ]),
          ]
          const slotSize = 24 / zoom
          const groupWidth = slotSize * slots.length
          const left = box.x + box.width - groupWidth
          const top = box.y - 30 / zoom
          return (
            <g data-testid="node-tools">
              <rect
                x={left}
                y={top}
                width={groupWidth}
                height={slotSize}
                rx={6 / zoom}
                fill="var(--background)"
                stroke={TOOL_EDGE}
                strokeWidth={1 / zoom}
              />
              {slots.map((slot, index) => {
                const cx = left + slotSize * index + slotSize / 2
                const cy = top + slotSize / 2
                return (
                  // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this canvas-space position under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
                  <g
                    key={slot.kind}
                    data-testid={
                      slot.kind === 'open' ? 'open-in-editor-handle' : 'more-actions-handle'
                    }
                    role="button"
                    tabIndex={0}
                    aria-label={slot.label}
                    {...(slot.kind === 'more' ? { 'aria-haspopup': 'menu' as const } : {})}
                    style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                    onPointerDown={(e) => {
                      // Keep the press away from the root's node/empty
                      // hit-test; the action itself fires on pointerup.
                      e.stopPropagation()
                    }}
                    onPointerUp={(e) => {
                      // pointerup, not click: the editor root preventDefaults
                      // native touchstart (its iOS long-press suppression),
                      // which cancels the synthetic mouse-compatibility
                      // events — a touch tap never produces a click here.
                      e.stopPropagation()
                      slot.run()
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      slot.run()
                    }}
                  >
                    {/* The hit area: transparent, so the quiet pill stays the
                        only thing drawn until a pointer asks for more. */}
                    <rect
                      x={left + slotSize * index}
                      y={top}
                      width={slotSize}
                      height={slotSize}
                      rx={6 / zoom}
                      fill="transparent"
                    />
                    {index > 0 && (
                      <line
                        x1={left + slotSize * index}
                        y1={top + 5 / zoom}
                        x2={left + slotSize * index}
                        y2={top + slotSize - 5 / zoom}
                        stroke={TOOL_EDGE}
                        strokeWidth={1 / zoom}
                      />
                    )}
                    {slot.kind === 'open' ? (
                      /* An arrow leaving a frame: the same "this takes you
                         elsewhere" glyph a link out of the page carries,
                         drawn rather than typed so no platform font can turn
                         it into tofu. */
                      <g
                        fill="none"
                        stroke={TOOL_INK}
                        strokeWidth={1.5 / zoom}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path
                          d={[
                            `M ${cx + 1 / zoom} ${cy - 5 / zoom}`,
                            `l ${-5 / zoom} 0`,
                            `l 0 ${10 / zoom}`,
                            `l ${10 / zoom} 0`,
                            `l 0 ${-5 / zoom}`,
                          ].join(' ')}
                        />
                        <path
                          d={[
                            `M ${cx} ${cy - 1 / zoom}`,
                            `l ${5 / zoom} ${-5 / zoom}`,
                            `M ${cx + 1 / zoom} ${cy - 6 / zoom}`,
                            `l ${4 / zoom} 0 l 0 ${4 / zoom}`,
                          ].join(' ')}
                        />
                      </g>
                    ) : (
                      /* Three dots as real circles, not a "⋯" glyph — a text
                         character rides the platform font and renders as
                         emoji or tofu on some systems, which is no way to
                         draw a control. */
                      [-5, 0, 5].map((dx) => (
                        <circle
                          key={dx}
                          cx={cx + dx / zoom}
                          cy={cy}
                          r={1.6 / zoom}
                          fill={TOOL_INK}
                        />
                      ))
                    )}
                  </g>
                )
              })}
            </g>
          )
        })()}
    </svg>
  )
}
