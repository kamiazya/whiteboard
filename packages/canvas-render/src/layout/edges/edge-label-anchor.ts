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
  return midpointOf(path, rounded)?.point
}

/** The arc-length midpoint and the drawn segment it lies on. */
function midpointOf(
  path: readonly Point[],
  rounded?: boolean,
): { point: Point; from: Point; to: Point } | undefined {
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
      return {
        point: { x: from.x + t * (to.x - from.x), y: from.y + t * (to.y - from.y) },
        from,
        to,
      }
    }
    remaining -= lengths[i]!
  }
  const last = drawn[drawn.length - 1]!
  return { point: last, from: drawn[drawn.length - 2]!, to: last }
}

export type LabelSize = { readonly w: number; readonly h: number }
export type LabelObstacle = {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}
type Rect = LabelObstacle

/**
 * What an edge label must not lie over: every non-container node, the
 * edge's own endpoints included. A frame is a region, not a box.
 */
export function labelObstacles(
  nodes: readonly {
    readonly type: string
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }[],
): LabelObstacle[] {
  return nodes
    .filter((node) => node.type !== 'group')
    .map((node) => ({ x: node.x, y: node.y, w: node.width, h: node.height }))
}

/** Offsets tried, in px off the line, and how far the search reaches. */
const LABEL_SLIDE_STEP_PX = 8
const LABEL_SLIDE_REACH_PX = 128

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Where a label of `size` sits on an edge: the midpoint, unless a label
 * centred there would lie over one of `obstacles` — the boxes on the board,
 * the edge's own endpoints included — in which case it slides off the line
 * along the segment's normal, nearest clear offset first, above (or left)
 * before below (or right). A label on a 50px edge between two boxes is
 * wider than the gap and covered both on the line; beside the row it covers
 * neither and still reads as that edge's. Nothing clear within reach leaves
 * it at the midpoint, which is at least where a reader looks first.
 *
 * The one producer for the renderer's label box and the editor's inline
 * label editor alike, for the reason `edgeLabelAnchor` gives.
 */
export function edgeLabelPlacement(
  path: readonly Point[],
  size: LabelSize,
  obstacles: readonly Rect[],
  rounded?: boolean,
): Point | undefined {
  const mid = midpointOf(path, rounded)
  if (mid === undefined) return undefined
  const boxAt = (c: Point): Rect => ({
    x: c.x - size.w / 2,
    y: c.y - size.h / 2,
    w: size.w,
    h: size.h,
  })
  const clear = (c: Point) => !obstacles.some((o) => overlaps(boxAt(c), o))
  if (clear(mid.point)) return mid.point
  const length = Math.hypot(mid.to.x - mid.from.x, mid.to.y - mid.from.y)
  if (length === 0) return mid.point
  const dir = { x: (mid.to.x - mid.from.x) / length, y: (mid.to.y - mid.from.y) / length }
  const normals = [
    { x: -dir.y, y: dir.x },
    { x: dir.y, y: -dir.x },
  ].sort((a, b) => a.y - b.y || a.x - b.x)
  for (let d = LABEL_SLIDE_STEP_PX; d <= LABEL_SLIDE_REACH_PX; d += LABEL_SLIDE_STEP_PX) {
    for (const n of normals) {
      const candidate = { x: mid.point.x + n.x * d, y: mid.point.y + n.y * d }
      if (clear(candidate)) return candidate
    }
  }
  return mid.point
}
