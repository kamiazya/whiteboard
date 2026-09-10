/**
 * The selected connection's bend affordance, wired to the gesture machine.
 *
 * Its own component rather than a block in the editor: the three handlers
 * are the same shape (take the press, dispatch one gesture event), and the
 * editor already carries every other overlay's wiring. What it needs from
 * the editor is only what no overlay can compute for itself — the pointer's
 * canvas point once capture is taken, and somewhere to send an event.
 */
import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { resolveEdgeWaypoints } from '@kamiazya/whiteboard-plugin-visual'
import type { Point, Viewport } from '../../lib/spatial/viewport.js'
import { clientPointToRootLocal, screenToCanvas } from '../../lib/spatial/viewport.js'
import { EdgeBendHandles } from './EdgeBendHandles.js'
import type { GestureEvent } from './gestures.js'

export function EdgeBendLayer({
  edge,
  path,
  viewport,
  begin,
  dispatch,
}: {
  readonly edge: CanvasEdge
  /** The DRAWN line, which is where a ghost handle can sit. */
  readonly path: readonly Point[]
  readonly viewport: Viewport
  /** Takes pointer capture for the press, and answers the editor's root. */
  readonly begin: (event: React.PointerEvent) => HTMLElement | null
  readonly dispatch: (event: GestureEvent) => void
}) {
  // The bends the edge STORES, which is not the drawn path: that one
  // carries the endpoints and whatever the flattener added, and only these
  // can be grabbed.
  const stored = resolveEdgeWaypoints(edge)
  const edgeId = edge.id
  return (
    <EdgeBendHandles
      path={path}
      stored={stored}
      zoom={viewport.zoom}
      onPress={(press, event) => {
        const root = begin(event)
        if (root === null) return
        dispatch({
          type: 'pointerdown-bend',
          edgeId,
          index: press.index,
          waypoints: press.waypoints,
          point: screenToCanvas(clientPointToRootLocal(event, root), viewport),
        })
      }}
      onRemove={(index) => dispatch({ type: 'remove-bend', edgeId, index })}
      onNudge={(index, dx, dy) => dispatch({ type: 'move-bend', edgeId, index, dx, dy })}
    />
  )
}
