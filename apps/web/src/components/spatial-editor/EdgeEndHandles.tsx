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
import { hasCoarsePointer } from '../../lib/platform.js'
import type { Point } from '../../lib/spatial/viewport.js'

/** Half-width in SCREEN pixels — divided by zoom so a handle stays grabbable. */
const HANDLE_HALF_PX = 6
/**
 * Half the target a FINGER gets, in screen pixels: the 44px touch floor the
 * selection's resize handles use. The marker stays small so it does not
 * cover the ink; only what takes the press grows.
 */
const COARSE_HIT_HALF_PX = 22

const ENDPOINTS = [
  { endpoint: 'from', label: 'start' },
  { endpoint: 'to', label: 'end' },
] as const

type Endpoint = 'from' | 'to'

export function EdgeEndHandles({
  path,
  zoom,
  subject = 'this connection',
  onArm,
}: {
  readonly path: readonly Point[]
  /** What the ends belong to, as a screen reader should hear it ("this drawing"). */
  readonly subject?: string
  readonly zoom: number
  /**
   * Arms the re-attachment. The pointer event is handed over so the caller
   * can take capture, and is ABSENT when the keyboard armed it — there is
   * no pointer to capture then, and pretending otherwise would have the
   * caller capture a key press.
   */
  readonly onArm: (endpoint: Endpoint, event?: React.PointerEvent) => void
}) {
  if (path.length < 2) return null
  const scale = Math.max(zoom, 0.01)
  const hitHalf = hasCoarsePointer() ? COARSE_HIT_HALF_PX / scale : undefined
  return (
    <svg
      style={{ position: 'absolute', overflow: 'visible', left: 0, top: 0, pointerEvents: 'none' }}
    >
      <title>Ends</title>
      {ENDPOINTS.map(({ endpoint, label }) => (
        <EndHandle
          key={endpoint}
          endpoint={endpoint}
          label={label}
          subject={subject}
          point={(endpoint === 'from' ? path[0] : path[path.length - 1]) as Point}
          scale={scale}
          hitHalf={hitHalf}
          onArm={onArm}
        />
      ))}
    </svg>
  )
}

function EndHandle({
  endpoint,
  label,
  subject,
  point,
  scale,
  hitHalf,
  onArm,
}: {
  readonly endpoint: Endpoint
  readonly label: string
  readonly subject: string
  readonly point: Point
  readonly scale: number
  /** Half the transparent target a finger gets, or absent for a fine pointer. */
  readonly hitHalf: number | undefined
  readonly onArm: (endpoint: Endpoint, event?: React.PointerEvent) => void
}) {
  const half = HANDLE_HALF_PX / scale
  const arm = armOnPress(endpoint, onArm)
  return (
    <>
      {hitHalf !== undefined && (
        <FingerTarget endpoint={endpoint} point={point} half={hitHalf} onPress={arm} />
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to render/hit-test at this canvas-space point under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand. */}
      <rect
        data-testid={`edge-end-handle-${endpoint}`}
        x={point.x - half}
        y={point.y - half}
        width={half * 2}
        height={half * 2}
        fill="var(--background, #fff)"
        stroke="var(--manipulation)"
        strokeWidth={2 / scale}
        style={{ pointerEvents: 'auto', cursor: 'grab' }}
        onPointerDown={arm}
        role="button"
        tabIndex={0}
        aria-label={`Move the ${label} of ${subject}`}
        onKeyDown={armOnKey(endpoint, onArm)}
      >
        <title>Drag to attach this {label} somewhere else</title>
      </rect>
    </>
  )
}

/** The transparent, finger-sized press target around an end's marker. */
function FingerTarget({
  endpoint,
  point,
  half,
  onPress,
}: {
  readonly endpoint: Endpoint
  readonly point: Point
  readonly half: number
  readonly onPress: (event: React.PointerEvent) => void
}) {
  return (
    <rect
      data-testid={`edge-end-hit-${endpoint}`}
      x={point.x - half}
      y={point.y - half}
      width={half * 2}
      height={half * 2}
      fill="transparent"
      style={{ pointerEvents: 'auto', cursor: 'grab' }}
      onPointerDown={onPress}
    />
  )
}

const armOnPress =
  (endpoint: Endpoint, onArm: (endpoint: Endpoint, event: React.PointerEvent) => void) =>
  (event: React.PointerEvent) => {
    if (event.button !== 0) return
    // The root's own hit-test must not also see this press, or it starts a
    // second gesture and this one never reaches its pointerup.
    event.stopPropagation()
    onArm(endpoint, event)
  }

/**
 * Enter or Space arms the same re-attachment the press does. What follows is
 * the box targets, which are focusable for exactly this reason: an
 * affordance only a pointer can reach is a verb a keyboard user has no way
 * to perform.
 */
const armOnKey =
  (endpoint: Endpoint, onArm: (endpoint: Endpoint) => void) => (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    onArm(endpoint)
  }
