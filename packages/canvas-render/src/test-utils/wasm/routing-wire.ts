import {
  type EdgeEnd,
  edgeSideSchema,
  type LineEnd,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'

/**
 * The edge layer's input as one flat number array, the routing wire
 * `crates/bindings/wasm/src/routing_wire.rs` decodes (ADR-0054 decision 9's
 * typed-array fast path). Ids are interned here, each distinct string to one
 * integer, so two equal ids stay one id across the boundary; the tables map
 * an integer back to its string.
 */
export interface RoutingWire {
  readonly values: number[]
  readonly nodeIds: readonly string[]
  readonly edgeIds: readonly string[]
}

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

const sideIndex = (side: string | undefined) =>
  side === undefined
    ? -1
    : edgeSideSchema.options.indexOf(side as (typeof edgeSideSchema.options)[number])
const arrowhead = (end: string | undefined) => (end === undefined ? -1 : end === 'arrow' ? 1 : 0)

function endValues(end: LineEnd | EdgeEnd, nodes: Interner): number[] {
  if ('kind' in end && end.kind === 'point')
    return [1, end.point.x, end.point.y, -1, arrowhead(end.end)]
  return [0, nodes.of(end.node), Number.NaN, sideIndex(end.side), arrowhead(end.end)]
}

export function encodeRouting(
  nodes: readonly SpatialNode[],
  edges: readonly RoutableElement[],
): RoutingWire {
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
  return { values, nodeIds: nodeIds.ids, edgeIds: edgeIds.ids }
}
