import type { EdgeRoutingStyle, EdgeSide, SpatialNode } from '@kamiazya/whiteboard-model'
import { edgeSideSchema } from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import type { Rect } from '../../layout/edges/edge-geometry.js'
import type {
  EdgeAnchorOverride,
  EdgeAnchorPair,
  EdgeStyleOf,
} from '../../layout/edges/edge-sides.js'
import { createRoutingBudget, type RoutingBudget } from '../../layout/edges/routing-budget.js'
import { requireWasm } from './glue.js'
import { encodeRouting } from './routing-wire.js'

/**
 * `assignEdgeAnchors` answered by the Rust port through the wasm artifact,
 * with the TypeScript signature, so canvas-render-rust runs every suite that
 * reaches the side-choice search — the routing scoreboards through
 * `layoutSpatialCanvas` included — against Rust unchanged (ADR-0054 step 5,
 * QR-21 layer 1). vitest.rust.config.ts aliases `./spatial-edges.js` and
 * `./edges/spatial-edges.js` to this module; the rest of spatial-edges.ts's
 * surface is re-exported as written.
 */
export {
  anchorsWithoutCoincidentEnds,
  routeCacheKey,
} from '../../layout/edges/spatial-edges.js'

const SIDES = edgeSideSchema.options
const STYLES: Record<EdgeRoutingStyle, number> = { straight: 0, orthogonal: 1, curved: 2 }
const sideIndex = (side: EdgeSide | undefined) => (side === undefined ? -1 : SIDES.indexOf(side))
const flagged = (value: number | undefined) => (value === undefined ? [0, 0] : [1, value])
const flaggedPoint = (p: { x: number; y: number } | undefined) =>
  p === undefined ? [0, 0, 0] : [1, p.x, p.y]

function overrideValues(
  overrides: ReadonlyMap<string, EdgeAnchorOverride> | undefined,
  edgeIds: readonly string[],
): number[] {
  if (overrides === undefined) return [0]
  // An override naming no edge is skipped by the search, and the wire has
  // no integer for it.
  const known = [...overrides].filter(([id]) => edgeIds.includes(id))
  return [
    1,
    known.length,
    ...known.flatMap(([id, p]) => [
      edgeIds.indexOf(id),
      sideIndex(p.fromSide),
      sideIndex(p.toSide),
      p.around === true ? 1 : 0,
      ...flaggedPoint(p.from),
      ...flagged(p.fromLaneDepth),
      ...flaggedPoint(p.to),
      ...flagged(p.toLaneDepth),
    ]),
  ]
}

/** One answer entry: 14 numbers, as `edge_compute_anchors` answers them. */
function entryOf(out: Float64Array, at: number): EdgeAnchorPair {
  const point = (i: number) =>
    out[i] === 1 ? { x: out[i + 1] as number, y: out[i + 2] as number } : undefined
  const from = point(at + 1)
  const to = point(at + 4)
  const fromLane = out[at + 7] === 1 ? (out[at + 8] as number) : undefined
  const toLane = out[at + 9] === 1 ? (out[at + 10] as number) : undefined
  const fromSide = SIDES[out[at + 11] as number]
  const toSide = SIDES[out[at + 12] as number]
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(fromLane === undefined ? {} : { fromLaneDepth: fromLane }),
    ...(toLane === undefined ? {} : { toLaneDepth: toLane }),
    ...(fromSide === undefined ? {} : { fromSide }),
    ...(toSide === undefined ? {} : { toSide }),
    ...(out[at + 13] === 1 ? { around: true as const } : {}),
  }
}

export function assignEdgeAnchors(
  nodes: readonly SpatialNode[],
  allEdges: readonly RoutableElement[],
  style: EdgeRoutingStyle | EdgeStyleOf = 'straight',
  sideOverrides?: ReadonlyMap<string, EdgeAnchorOverride>,
  budget: RoutingBudget = createRoutingBudget(),
  labels: readonly Rect[] = [],
): ReadonlyMap<string, EdgeAnchorPair> {
  const styleOf: EdgeStyleOf = typeof style === 'function' ? style : () => style
  const wire = encodeRouting(nodes, allEdges)
  const input = Float64Array.from([
    ...wire.values,
    ...allEdges.map((edge) => STYLES[styleOf(edge)]),
    ...overrideValues(sideOverrides, wire.edgeIds),
    labels.length,
    ...labels.flatMap((r) => [r.x, r.y, r.w, r.h]),
    budget.grid,
    budget.pairs,
    budget.trials,
    budget.repairs,
  ])
  const out = requireWasm().edge_assign_anchors(input)
  if (out.length < 5) throw new Error('edge_assign_anchors refused its input')
  budget.grid = out[0] as number
  budget.pairs = out[1] as number
  budget.trials = out[2] as number
  budget.repairs = out[3] as number
  const anchors = new Map<string, EdgeAnchorPair>()
  for (let i = 0; i < (out[4] as number); i++) {
    const at = 5 + 14 * i
    anchors.set(wire.edgeIds[out[at] as number] as string, entryOf(out, at))
  }
  return anchors
}
