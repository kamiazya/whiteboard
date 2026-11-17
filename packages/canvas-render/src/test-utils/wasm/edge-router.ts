import type { EdgeRoutingStyle, EdgeSide, SpatialNode } from '@kamiazya/whiteboard-model'
import { edgeSideSchema } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import type { EdgeAnchorPair, RoutingBudget } from '../../edge-routing.js'
import type { Rect } from '../../generated/geometry.zod.js'
import { requireWasm } from './glue.js'
import { encodeRouting } from './routing-wire.js'

/**
 * `routeEdge` answered by the Rust port through the wasm artifact's
 * oracle-surface export (`edge_route_edge`), with the signature the deleted
 * TypeScript router had, so canvas-render-rust's routing examples and
 * scoreboards (`src/routing/*.rust.test.ts`) route one edge between the
 * anchors they choose (ADR-0054 step 5, QR-21 layer 1; the TypeScript went in
 * step 7, S18h3b). Test-only: no shipped artifact carries the export.
 */

const SIDES = edgeSideSchema.options
const STYLES: Record<EdgeRoutingStyle, number> = { straight: 0, orthogonal: 1, curved: 2 }
const sideIndex = (side: EdgeSide | undefined) => (side === undefined ? -1 : SIDES.indexOf(side))
const flagged = (value: number | undefined) => (value === undefined ? [0, 0] : [1, value])
const flaggedPoint = (p: { x: number; y: number } | undefined) =>
  p === undefined ? [0, 0, 0] : [1, p.x, p.y]
const rectValues = (rs: readonly Rect[]) => rs.flatMap((r) => [r.x, r.y, r.w, r.h])

function anchorValues(anchors: EdgeAnchorPair | undefined): number[] {
  if (anchors === undefined) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, -1, 0]
  return [
    1,
    ...flaggedPoint(anchors.from),
    ...flaggedPoint(anchors.to),
    ...flagged(anchors.fromLaneDepth),
    ...flagged(anchors.toLaneDepth),
    sideIndex(anchors.fromSide),
    sideIndex(anchors.toSide),
    anchors.around === true ? 1 : 0,
  ]
}

export function routeEdge(
  nodes: readonly SpatialNode[],
  edge: RoutableElement,
  style: EdgeRoutingStyle = 'straight',
  anchors?: EdgeAnchorPair,
  others?: readonly Rect[],
  budget?: RoutingBudget,
  labels: readonly Rect[] = [],
): ResolvedEdgeNode {
  const wire = encodeRouting(nodes, [edge])
  const input = Float64Array.from([
    ...wire.values,
    STYLES[style],
    ...anchorValues(anchors),
    ...(others === undefined ? [-1] : [others.length, ...rectValues(others)]),
    ...flagged(budget?.grid),
    labels.length,
    ...rectValues(labels),
  ])
  const out = requireWasm().edge_route_edge(input)
  if (out.length < 7) throw new Error('edge_route_edge refused its input')
  const [spent, rounded, fromSide, toSide, fromEnd, toEnd, n] = out as unknown as number[]
  if (budget !== undefined) budget.grid -= spent as number
  const path = Array.from({ length: n as number }, (_, i) => ({
    x: out[7 + 2 * i] as number,
    y: out[8 + 2 * i] as number,
  }))
  return {
    kind: 'edge',
    id: edge.id,
    path,
    ...(rounded === 1 ? { rounded: true as const } : {}),
    fromSide: SIDES[fromSide as number] as EdgeSide,
    toSide: SIDES[toSide as number] as EdgeSide,
    fromEnd: fromEnd === 1 ? 'arrow' : 'none',
    toEnd: toEnd === 1 ? 'arrow' : 'none',
  }
}
