/**
 * The bends of the selected connection, as grab handles — and a ghost
 * handle on each straight run for adding one.
 *
 * Drawn in canvas space, over the same path `EdgeSelectionHighlight` uses,
 * so a handle sits on the ink a tap selected rather than on the route
 * before it was flattened.
 *
 * The overlay owns the INSERTION: it hands the reducer the list the edge
 * should end with, already carrying the new point, so adding a bend and
 * moving one are the same drag. Where a point is worth inserting is
 * geometry only this side has.
 */
import type { Point } from '../../lib/spatial/viewport.js'

/** Radius in SCREEN pixels — divided by zoom so a handle stays grabbable. */
const HANDLE_RADIUS_PX = 6
const GHOST_RADIUS_PX = 4
/**
 * A run shorter than this offers no ghost: the two sit a third of the run
 * apart, so a short run makes them a coin toss to hit — and the run either
 * side of a bend is short by construction on a tight corner.
 */
const MIN_GHOST_RUN_PX = 60
/**
 * Ghosts sit at a THIRD and two thirds of a run, never at its midpoint.
 *
 * The midpoint belongs to the edge's label: it is where `edgeLabelAnchor`
 * draws one and where double-pressing an edge opens its editor. A ghost
 * there swallows the second press — measured, it failed every case in
 * `edge-label-edit.browser.test.tsx` while the bend tests stayed green,
 * because both affordances were aiming at the same pixel.
 */
const GHOST_FRACTIONS = [1 / 3, 2 / 3] as const
/** Canvas units per arrow press, and how much further Shift takes it. */
const NUDGE_STEP_PX = 1
const NUDGE_SHIFT_FACTOR = 10
const NUDGE_KEYS: Readonly<Record<string, { readonly x: number; readonly y: number }>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
}

export interface BendPress {
  /** The list the edge ends with, before the drag — with the new point already in it. */
  readonly waypoints: readonly Point[]
  readonly index: number
}

/**
 * Where a ghost handle goes: the midpoint of each drawn run, with the index
 * it would take among the STORED bends.
 *
 * The drawn path is the stored bends plus the two endpoints, so run `i`
 * sits between stored bend `i - 1` and stored bend `i`, and a point
 * inserted there takes index `i`. Runs the flattener produced (a rounded
 * corner's arc, a line-jump hop) are not runs a person bent, which is why
 * this reads the DRAWN path and clamps rather than trusting the count.
 */
export function ghostPresses(
  path: readonly Point[],
  stored: readonly Point[],
  zoom: number,
): readonly (BendPress & { readonly at: Point })[] {
  const minRun = MIN_GHOST_RUN_PX / Math.max(zoom, 0.01)
  const out: (BendPress & { at: Point })[] = []
  for (let run = 0; run + 1 < path.length; run++) {
    const a = path[run] as Point
    const b = path[run + 1] as Point
    if (Math.hypot(b.x - a.x, b.y - a.y) < minRun) continue
    const index = Math.min(run, stored.length)
    for (const fraction of GHOST_FRACTIONS) {
      const at = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction }
      out.push({
        at,
        index,
        waypoints: [...stored.slice(0, index), at, ...stored.slice(index)],
      })
    }
  }
  return out
}

export function EdgeBendHandles({
  path,
  stored,
  zoom,
  onPress,
  onRemove,
  onNudge,
}: {
  readonly path: readonly Point[]
  readonly stored: readonly Point[]
  readonly zoom: number
  readonly onPress: (press: BendPress, event: React.PointerEvent) => void
  readonly onRemove: (index: number) => void
  /** The keyboard's drag: arrows move the focused bend, Shift moves it further. */
  readonly onNudge: (index: number, dx: number, dy: number) => void
}) {
  if (path.length < 2) return null
  const radius = HANDLE_RADIUS_PX / Math.max(zoom, 0.01)
  const ghostRadius = GHOST_RADIUS_PX / Math.max(zoom, 0.01)
  return (
    <svg
      style={{ position: 'absolute', overflow: 'visible', left: 0, top: 0, pointerEvents: 'none' }}
    >
      <title>Connection bends</title>
      {ghostPresses(path, stored, zoom).map((ghost) => (
        <circle
          key={`ghost-${ghost.index}-${ghost.at.x}-${ghost.at.y}`}
          data-testid="edge-bend-ghost"
          cx={ghost.at.x}
          cy={ghost.at.y}
          r={ghostRadius}
          fill="var(--background, #fff)"
          stroke="var(--manipulation)"
          strokeWidth={1 / Math.max(zoom, 0.01)}
          style={{ pointerEvents: 'auto', cursor: 'grab' }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            // The root's own hit-test must not also see this press, or it
            // starts a second gesture and the bend one never reaches its
            // pointerup.
            event.stopPropagation()
            onPress({ waypoints: ghost.waypoints, index: ghost.index }, event)
          }}
        >
          <title>Add a bend here</title>
        </circle>
      ))}
      {stored.map((point, index) => (
        // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this canvas-space point under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
        <circle
          key={`bend-${index}-${point.x}-${point.y}`}
          data-testid="edge-bend-handle"
          cx={point.x}
          cy={point.y}
          r={radius}
          fill="var(--manipulation)"
          style={{ pointerEvents: 'auto', cursor: 'grab' }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.stopPropagation()
            onPress({ waypoints: stored, index }, event)
          }}
          // A bend is taken back out by pressing it again rather than by
          // dragging it somewhere harmless: a drag has no "away", and the
          // nearest thing to one — dropping it back on the straight line —
          // would delete a bend somebody was still placing.
          onDoubleClick={(event) => {
            event.stopPropagation()
            onRemove(index)
          }}
          // Focusable and answerable from the keyboard, like the resize
          // handles: an affordance only a pointer can reach is one a
          // keyboard user cannot undo either, and a stored bend is a
          // change they can be looking at.
          role="button"
          tabIndex={0}
          aria-label={`Bend ${index + 1} of the connection`}
          onKeyDown={(event) => {
            const step = NUDGE_STEP_PX * (event.shiftKey ? NUDGE_SHIFT_FACTOR : 1)
            const delta = NUDGE_KEYS[event.key]
            if (delta !== undefined) {
              event.preventDefault()
              event.stopPropagation()
              onNudge(index, delta.x * step, delta.y * step)
              return
            }
            if (event.key === 'Delete' || event.key === 'Backspace') {
              event.preventDefault()
              // The canvas answers Delete by removing the SELECTED edge, so
              // a bend that let the key through would delete the connection
              // it belongs to.
              event.stopPropagation()
              onRemove(index)
            }
          }}
        >
          <title>Bend {index + 1} — drag to move, double-press to remove</title>
        </circle>
      ))}
    </svg>
  )
}
