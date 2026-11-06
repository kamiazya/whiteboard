/**
 * The "more actions" chip for a selected stroke or relation — the same
 * doorway a selected node carries, onto the same menu right-click opens.
 *
 * Without it the menu was reachable only by right-click or a long-press,
 * and the long-press is a gesture nothing on screen announces: a stroke
 * drawn on a tablet in an earlier session could not be found a Delete for.
 * Drawn above the top-right corner of the selection's drawn paths, the place
 * the node chip sits relative to its box — unless one of the path's own
 * handles is there, in which case `placePathChip` picks a clear corner.
 */
import { hasCoarsePointer } from '../../lib/platform.js'
import { type PathChipRect, placePathChip } from '../../lib/spatial/path-chip-placement.js'
import { canvasToScreen, type Point, type Viewport } from '../../lib/spatial/viewport.js'
import type { ContextMenuTarget } from './CanvasContextMenu.js'
import { MINIMAP_MIN_ROOT_WIDTH_PX } from './use-editor-measurements.js'

/** Half a handle's press target in screen pixels: `EdgeEndHandles`' finger target, else its marker. */
const HANDLE_HALF_FINE_PX = 6
const HANDLE_HALF_COARSE_PX = 22

const TOOL_INK = 'var(--muted-foreground, oklch(0.556 0 0))'
const TOOL_EDGE = 'var(--border, oklch(0.922 0 0))'

export function PathMoreActions({
  paths,
  handles,
  visible,
  zoom,
  subject,
  onOpen,
}: {
  /** The drawn paths of everything selected. */
  readonly paths: readonly (readonly Point[])[]
  /** Where the selection's own handles sit, which the chip must not cover. */
  readonly handles: readonly Point[]
  /** The canvas area on screen, in canvas coordinates. */
  readonly visible?: PathChipRect
  readonly zoom: number
  /** What the menu is about, as a screen reader should hear it ("this drawing"). */
  readonly subject: string
  /** Opens the menu, anchored at the chip, in canvas coordinates. */
  readonly onOpen: (anchor: Point) => void
}) {
  const scale = Math.max(zoom, 0.01)
  const coarse = hasCoarsePointer()
  // The node chip's sizes: a finger needs 44.
  const size = (coarse ? 44 : 24) / scale
  const corner = placePathChip({
    points: paths.flat(),
    handles,
    handleHalf: (coarse ? HANDLE_HALF_COARSE_PX : HANDLE_HALF_FINE_PX) / scale,
    size,
    gap: 6 / scale,
    ...(visible === undefined ? {} : { visible }),
  })
  if (corner === undefined) return null
  return (
    <svg
      style={{ position: 'absolute', overflow: 'visible', left: 0, top: 0, pointerEvents: 'none' }}
    >
      <title>Selection actions</title>
      <DotsButton
        box={{ ...corner, size }}
        scale={scale}
        label={`More actions for ${subject}`}
        onOpen={onOpen}
      />
    </svg>
  )
}

function DotsButton({
  box,
  scale,
  label,
  onOpen,
}: {
  readonly box: { readonly x: number; readonly y: number; readonly size: number }
  readonly scale: number
  readonly label: string
  readonly onOpen: (anchor: Point) => void
}) {
  const cx = box.x + box.size / 2
  const cy = box.y + box.size / 2
  const open = () => onOpen({ x: cx, y: cy })
  return (
    // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this canvas-space position under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
    <g
      data-testid="path-more-actions"
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-haspopup="menu"
      style={{ pointerEvents: 'auto', cursor: 'pointer' }}
      onPointerDown={(e) => {
        // Keep the press away from the root's hit-test; the action fires on
        // pointerup, because the root cancels a touch tap's click.
        e.stopPropagation()
      }}
      onPointerUp={(e) => {
        e.stopPropagation()
        open()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        open()
      }}
    >
      <DotsGlyph box={box} scale={scale} />
    </g>
  )
}

/**
 * The menu the chip opens: the one right-click opens for the same path, in
 * the vessel the node chip picks at the same width — a bottom sheet below
 * the minimap breakpoint, keyed off the editor's own width.
 */
export function pathMenuTarget(
  edgeId: string,
  point: Point,
  viewport: Viewport,
  rootWidth: number,
): ContextMenuTarget {
  const screen = canvasToScreen(point, viewport)
  return {
    x: screen.x,
    y: screen.y,
    nodeId: undefined,
    edgeId,
    point,
    variant: rootWidth < MINIMAP_MIN_ROOT_WIDTH_PX ? 'sheet' : 'grid',
  }
}

/** The chip's look: the node chip's quiet pill with three drawn dots. */
function DotsGlyph({
  box,
  scale,
}: {
  readonly box: { readonly x: number; readonly y: number; readonly size: number }
  readonly scale: number
}) {
  const cx = box.x + box.size / 2
  const cy = box.y + box.size / 2
  return (
    <>
      <rect
        x={box.x}
        y={box.y}
        width={box.size}
        height={box.size}
        rx={6 / scale}
        fill="var(--background)"
        stroke={TOOL_EDGE}
        strokeWidth={1 / scale}
      />
      {/* Three dots as circles rather than a glyph a platform font may draw
        as emoji or tofu. */}
      {[-5, 0, 5].map((dx) => (
        <circle key={dx} cx={cx + dx / scale} cy={cy} r={1.6 / scale} fill={TOOL_INK} />
      ))}
    </>
  )
}
