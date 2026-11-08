import {
  type EdgeEnd,
  type EdgeRoutingStyle,
  type EdgeSide,
  edgeSideSchema,
  type LineEnd,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import type { LabelRect, RoutingBudget, SideOverride } from './types.js'

/**
 * One layout's routing input as the flat number array
 * `crates/bindings/wasm/src/routing_wire.rs` decodes (ADR-0054 decision 9's
 * typed-array path). Ids are interned, each distinct string to one integer,
 * so two equal ids stay one id across the boundary; `edgeIds` maps an
 * integer back to its string.
 */
export interface LayoutWire {
  readonly input: Float64Array
  readonly edgeIds: readonly string[]
}

const SIDES = edgeSideSchema.options
const STYLES: Record<EdgeRoutingStyle, number> = { straight: 0, orthogonal: 1, curved: 2 }

/** A side's wire index, `-1` for none. */
const sideIndex = (side: EdgeSide | undefined): number =>
  side === undefined ? -1 : SIDES.indexOf(side)

/** The side a wire index names. */
export const sideAt = (index: number): EdgeSide | undefined => SIDES[index]

class Interner {
  readonly ids: string[] = []
  private readonly index = new Map<string, number>()
  of(id: string): number {
    let i = this.index.get(id)
    if (i === undefined) {
      i = this.ids.length
      this.ids.push(id)
      this.index.set(id, i)
    }
    return i
  }
}

const arrowhead = (end: string | undefined) => (end === undefined ? -1 : end === 'arrow' ? 1 : 0)
const flagged = (v: number | undefined) => (v === undefined ? [0, 0] : [1, v])
const flaggedPoint = (p: { x: number; y: number } | undefined) =>
  p === undefined ? [0, 0, 0] : [1, p.x, p.y]

function endValues(end: LineEnd | EdgeEnd, nodes: Interner): number[] {
  if ('kind' in end && end.kind === 'point')
    return [1, end.point.x, end.point.y, -1, arrowhead(end.end)]
  return [0, nodes.of(end.node), Number.NaN, sideIndex(end.side), arrowhead(end.end)]
}

function overrideValues(
  overrides: ReadonlyMap<string, SideOverride> | undefined,
  edgeIds: readonly string[],
): number[] {
  if (overrides === undefined) return [0]
  // An override naming no edge is skipped by the search, and the wire has no
  // integer for it.
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

/** The input `edge_route_layout` reads, as the composer would route it. */
export function encodeLayout(
  nodes: readonly SpatialNode[],
  edges: readonly RoutableElement[],
  styleOf: (edge: RoutableElement) => EdgeRoutingStyle,
  overrides: ReadonlyMap<string, SideOverride> | undefined,
  budget: RoutingBudget,
  labels: readonly LabelRect[],
): LayoutWire {
  const nodeIds = new Interner()
  const edgeIds = new Interner()
  const values: number[] = [nodes.length]
  for (const n of nodes) values.push(nodeIds.of(n.id), n.x, n.y, n.width, n.height)
  values.push(edges.length)
  for (const e of edges) {
    values.push(edgeIds.of(e.id), ...endValues(e.from, nodeIds), ...endValues(e.to, nodeIds))
    if (e.bends === undefined) values.push(-1)
    else values.push(e.bends.length, ...e.bends.flatMap((b) => [b.x, b.y]))
  }
  values.push(...edges.map((edge) => STYLES[styleOf(edge)]))
  values.push(...overrideValues(overrides, edgeIds.ids))
  values.push(labels.length, ...labels.flatMap((r) => [r.x, r.y, r.w, r.h]))
  values.push(budget.grid, budget.pairs, budget.trials, budget.repairs)
  return { input: Float64Array.from(values), edgeIds: edgeIds.ids }
}
