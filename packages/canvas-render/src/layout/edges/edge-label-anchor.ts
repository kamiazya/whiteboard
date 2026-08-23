// The single producer of "where an edge's label sits": the arc-length
// midpoint of the DRAWN line. Both the SVG backend (composeEdgeLabel) and
// the editor's inline label editor anchor here — two independent midpoint
// derivations is the drift class that put exported labels on the sharp
// corner a curved edge's ink never touches.
import { flattenRoundedEdgePath } from './edge-rounding.js'

type Point = { readonly x: number; readonly y: number }

/**
 * The point halfway along the drawn edge, by arc length. `rounded` applies
 * the same corner flattening the backend and hit-testing draw with, so the
 * anchor stays on the curve rather than the raw corner vertex.
 *
 * Returns `undefined` when the path draws no line — fewer than two points,
 * or every point at the same place. `routeEdge`'s missing-endpoint fallback
 * is that second case specifically: it degrades to `[origin, origin]`, a
 * two-point path of zero length. A point-count check alone would miss it
 * and leave a label floating at the canvas origin.
 */
export function edgeLabelAnchor(path: readonly Point[], rounded?: boolean): Point | undefined {
  const first = path[0]
  if (path.length < 2 || first === undefined) return undefined
  if (path.every((p) => p.x === first.x && p.y === first.y)) return undefined
  const drawn = rounded === true ? flattenRoundedEdgePath(path) : path
  const lengths: number[] = []
  let total = 0
  for (let i = 0; i + 1 < drawn.length; i++) {
    const length = Math.hypot(drawn[i + 1]!.x - drawn[i]!.x, drawn[i + 1]!.y - drawn[i]!.y)
    lengths.push(length)
    total += length
  }
  let remaining = total / 2
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]!) {
      const t = lengths[i] === 0 ? 0 : remaining / lengths[i]!
      const from = drawn[i]!
      const to = drawn[i + 1]!
      return { x: from.x + t * (to.x - from.x), y: from.y + t * (to.y - from.y) }
    }
    remaining -= lengths[i]!
  }
  return drawn[drawn.length - 1]
}
