// The single producer of "where an edge's label sits": the arc-length
// midpoint of the DRAWN line, slid clear of what it would cover. Both the SVG
// backend (composeEdgeLabel) and the editor's inline label editor place here —
// two independent midpoint derivations is the drift class that put exported
// labels on the sharp corner a curved edge's ink never touches.
//
// `rounded` applies the same corner flattening the backend and hit-testing
// draw with, so a label stays on the curve rather than the raw corner vertex.
// A path that draws no line — fewer than two points, or every point at one
// place (`routeEdge`'s missing-endpoint fallback is `[origin, origin]`) —
// has no place for a label: a point-count check alone would miss that case
// and leave a label floating at the canvas origin.
import { isFrame, type SpatialNode } from '@kamiazya/whiteboard-model'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import type { Point } from './edge-geometry.js'
import { flattenRoundedEdgePath } from './edge-rounding.js'

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
 * edge's own endpoints included, and `extra` (a frame's title, which hangs
 * outside the frame's box). A frame is a region, not a box.
 */
export function labelObstacles(
  nodes: readonly SpatialNode[],
  extra: readonly LabelObstacle[] = [],
): LabelObstacle[] {
  return [
    ...nodes
      .filter((node) => !isFrame(node))
      .map((node) => ({ x: node.x, y: node.y, w: node.width, h: node.height })),
    ...extra,
  ]
}

/**
 * The title boxes of the frames in a laid-out scene, for a caller that places
 * a label against a scene it already holds (the inline label editor) rather
 * than laying one out: the layout's own placement reads the same boxes, so the
 * editor and the drawn label agree on what is in the way.
 */
export function frameTitleObstacles(
  nodes: readonly SpatialNode[],
  sceneNodes: readonly SceneNode[],
): LabelObstacle[] {
  const frames = new Set(nodes.filter((node) => isFrame(node)).map((node) => node.id))
  return sceneNodes.flatMap((entry) =>
    entry.kind === 'textRun' && entry.annotates?.kind === 'node' && frames.has(entry.annotates.id)
      ? [{ x: entry.bbox.x, y: entry.bbox.y, w: entry.bbox.w, h: entry.bbox.h }]
      : [],
  )
}

/** Offsets tried, in px off the line, and how far the search reaches. */
const LABEL_SLIDE_STEP_PX = 8
const LABEL_SLIDE_REACH_PX = 128

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Where a label of `size` sits on an edge: the midpoint, unless a label
 * centred there would lie over one of `obstacles` — the boxes on the board,
 * the edge's own endpoints included — in which case it moves to the nearest
 * clear spot. Along the line comes first, while the drawn line has room: the
 * line is drawn from a node's outline but its box is a rectangle, so a label
 * that only clips that rectangle clears it a few pixels along and stays on
 * its line. Otherwise it slides off the line along the segment's normal,
 * above (or left) before below (or right). A label on a 50px edge between two
 * boxes is wider than the gap and covered both on the line; beside the row it
 * covers neither and still reads as that edge's. Nothing clear within reach
 * leaves it at the midpoint, which is at least where a reader looks first.
 *
 * The one producer for the renderer's label box and the editor's inline
 * label editor alike, for the reason the file header gives.
 */
export function edgeLabelPlacement(
  path: readonly Point[],
  size: LabelSize,
  obstacles: readonly Rect[],
  rounded?: boolean,
): Point | undefined {
  const mid = midpointOf(path, rounded)
  if (mid === undefined) return undefined
  // Every candidate centre lies within the slide reach of the midpoint on
  // both axes, so an obstacle missing this box misses every candidate
  // box. One pass over the board then, rather than one per candidate; the
  // pixel of margin absorbs the rounding of a candidate's offset.
  const margin = LABEL_SLIDE_REACH_PX + 1
  const searched: Rect = {
    x: mid.point.x - margin - size.w / 2,
    y: mid.point.y - margin - size.h / 2,
    w: size.w + 2 * margin,
    h: size.h + 2 * margin,
  }
  const near = obstacles.filter((o) => overlaps(searched, o))
  const clear = (c: Point) => {
    const box: Rect = { x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h }
    return !near.some((o) => overlaps(box, o))
  }
  if (clear(mid.point)) return mid.point
  return slideCandidates(mid).find(clear) ?? mid.point
}

/**
 * The spots a blocked label tries, nearest first: at each distance, along the
 * drawn line while it runs that far (a centre past its end is off the line),
 * then to either side of it, above (or left) before below (or right).
 */
function slideCandidates(mid: { point: Point; from: Point; to: Point }): Point[] {
  const length = Math.hypot(mid.to.x - mid.from.x, mid.to.y - mid.from.y)
  if (length === 0) return []
  const dir = { x: (mid.to.x - mid.from.x) / length, y: (mid.to.y - mid.from.y) / length }
  const byPosition = (a: Point, b: Point) => a.y - b.y || a.x - b.x
  const normals = [
    { x: -dir.y, y: dir.x },
    { x: dir.y, y: -dir.x },
  ].sort(byPosition)
  const runs = [
    { n: dir, room: Math.hypot(mid.to.x - mid.point.x, mid.to.y - mid.point.y) },
    {
      n: { x: -dir.x, y: -dir.y },
      room: Math.hypot(mid.from.x - mid.point.x, mid.from.y - mid.point.y),
    },
  ].sort((a, b) => byPosition(a.n, b.n))
  const at = (n: Point, d: number): Point => ({
    x: mid.point.x + n.x * d,
    y: mid.point.y + n.y * d,
  })
  const found: Point[] = []
  for (let d = LABEL_SLIDE_STEP_PX; d <= LABEL_SLIDE_REACH_PX; d += LABEL_SLIDE_STEP_PX) {
    for (const { n, room } of runs) if (d <= room) found.push(at(n, d))
    for (const n of normals) found.push(at(n, d))
  }
  return found
}
