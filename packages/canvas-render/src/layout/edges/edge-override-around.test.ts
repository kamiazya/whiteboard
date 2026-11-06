// A drag freezes every edge it does not carry at its committed state, so the
// edges nobody touched hold still. A straight edge the committed search
// stepped round what was in its way (`around`) is part of that state: an
// override that names its sides and pins its anchors but drops `around`
// hands the edge back its corner route, which it then jumps to mid-drag.
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { stackedFramesBoard } from '../../test-utils/routing-corpus.js'
import { routeEdge } from './edge-router.js'
import type { EdgeAnchorOverride } from './edge-sides.js'
import { assignEdgeAnchors } from './spatial-edges.js'

describe('an override of a straight edge stepping round', () => {
  it('keeps the committed route while an unrelated node is dragged', () => {
    const { nodes, edges } = stackedFramesBoard()
    const committed = assignEdgeAnchors(nodes, edges, 'straight')
    const stepping = edges.filter((edge) => committed.get(edge.id)?.around === true)
    // The board exists to need it: two diagonals cross unless one steps round.
    expect(stepping.length).toBeGreaterThan(0)

    // a4 carries no edge, so every edge is a bystander and frozen whole.
    const dragged: SpatialNode[] = nodes.map((n) => (n.id === 'a4' ? { ...n, x: n.x + 8 } : n))
    const overrides = new Map<string, EdgeAnchorOverride>(
      edges.map((edge) => {
        const pin = committed.get(edge.id)!
        return [edge.id, { ...pin, fromSide: pin.fromSide!, toSide: pin.toSide! }] as const
      }),
    )
    const live = assignEdgeAnchors(dragged, edges, 'straight', overrides)
    for (const edge of stepping) {
      expect(live.get(edge.id)?.around, edge.id).toBe(true)
      expect(routeEdge(dragged, edge, 'straight', live.get(edge.id)).path, edge.id).toEqual(
        routeEdge(nodes, edge, 'straight', committed.get(edge.id)).path,
      )
    }
  })

  it('is what holds it: the same override without `around` takes the corner route', () => {
    const { nodes, edges } = stackedFramesBoard()
    const committed = assignEdgeAnchors(nodes, edges, 'straight')
    const overrides = new Map<string, EdgeAnchorOverride>(
      edges.map((edge) => {
        const { around: _dropped, ...pin } = committed.get(edge.id)!
        return [edge.id, { ...pin, fromSide: pin.fromSide!, toSide: pin.toSide! }] as const
      }),
    )
    const live = assignEdgeAnchors(nodes, edges, 'straight', overrides)
    const moved = edges.filter(
      (edge) =>
        committed.get(edge.id)?.around === true &&
        JSON.stringify(routeEdge(nodes, edge, 'straight', live.get(edge.id)).path) !==
          JSON.stringify(routeEdge(nodes, edge, 'straight', committed.get(edge.id)).path),
    )
    expect(moved.length).toBeGreaterThan(0)
  })
})
