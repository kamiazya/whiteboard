/**
 * The two ENDS of the selected relation or stroke, as grab handles.
 *
 * Drawn over the same path `EdgeBendHandles` draws its bends on, so a
 * handle sits on the ink a tap selected rather than on the route before it
 * was flattened. SQUARE where a bend is round, because the two affordances
 * sit on one path and do different things: a bend moves a point the element
 * is drawn through, an end moves what the element is ON.
 *
 * The press carries no point. A re-attachment is not a translation, so
 * what the RELEASE names is the whole answer — which is also why these
 * handles do not answer the arrow keys the way a bend does. The keyboard
 * path is the box targets the armed gesture puts on the board.
 */
import type { Point } from '../../lib/spatial/viewport.js'

/** Half-width in SCREEN pixels — divided by zoom so a handle stays grabbable. */
const HANDLE_HALF_PX = 6

const ENDPOINTS = [
  { endpoint: 'from', label: 'start' },
  { endpoint: 'to', label: 'end' },
] as const

export function EdgeEndHandles({
  path,
  zoom,
  onArm,
}: {
  readonly path: readonly Point[]
  readonly zoom: number
  /**
   * Arms the re-attachment. The pointer event is handed over so the caller
   * can take capture, and is ABSENT when the keyboard armed it — there is
   * no pointer to capture then, and pretending otherwise would have the
   * caller capture a key press.
   */
  readonly onArm: (endpoint: 'from' | 'to', event?: React.PointerEvent) => void
}) {
  if (path.length < 2) return null
  const half = HANDLE_HALF_PX / Math.max(zoom, 0.01)
  const at = (endpoint: 'from' | 'to') =>
    (endpoint === 'from' ? path[0] : path[path.length - 1]) as Point
  return (
    <svg
      style={{ position: 'absolute', overflow: 'visible', left: 0, top: 0, pointerEvents: 'none' }}
    >
      <title>Connection ends</title>
      {ENDPOINTS.map(({ endpoint, label }) => {
        const point = at(endpoint)
        return (
          // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this canvas-space point under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
          <rect
            key={endpoint}
            data-testid={`edge-end-handle-${endpoint}`}
            x={point.x - half}
            y={point.y - half}
            width={half * 2}
            height={half * 2}
            fill="var(--background, #fff)"
            stroke="var(--manipulation)"
            strokeWidth={2 / Math.max(zoom, 0.01)}
            style={{ pointerEvents: 'auto', cursor: 'grab' }}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              // The root's own hit-test must not also see this press, or it
              // starts a second gesture and this one never reaches its
              // pointerup.
              event.stopPropagation()
              onArm(endpoint, event)
            }}
            role="button"
            tabIndex={0}
            aria-label={`Move the ${label} of this connection`}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              // Same arm the press makes. What follows is the box targets,
              // which are focusable for exactly this reason: an affordance
              // only a pointer can reach is a verb a keyboard user has no
              // way to perform.
              event.stopPropagation()
              onArm(endpoint)
            }}
          >
            <title>Drag to attach this {label} somewhere else</title>
          </rect>
        )
      })}
    </svg>
  )
}
