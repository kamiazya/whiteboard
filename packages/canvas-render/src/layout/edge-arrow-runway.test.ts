// An arrowhead is ARROW_LENGTH (10px) long and is drawn ON the final segment,
// so a shorter approach paints an arrow with no line behind it — it reads as a
// marker stuck to the box rather than an edge arriving at it.
//
// `routeOrthogonal` already rescues PERPENDICULAR pairs by sliding the
// departure anchor along its own side. Same-side pairs had no equivalent and
// were the larger source of the defect: measured over the routing corpus, 99
// short approaches came from same-side pairs against 11 from perpendicular
// ones. A same-side route runs a shared corridor at the departure stub's depth
// and comes back up into the arrival anchor, so when the ARRIVAL box extends
// further out than the departure box, the corridor clears it by less than the
// stub depth — by nothing at all once the difference exceeds it.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { finalSegmentLength } from '../test-utils/routing-metrics.js'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const ARROW_LENGTH_PX = 10

const route = (nodes: readonly SpatialNode[], edge: CanvasEdge) => {
  const anchors = assignEdgeAnchors(nodes, [edge], 'orthogonal')
  return routeEdge(nodes, edge, 'orthogonal', anchors.get(edge.id))
}

describe('a same-side route leaves its arrowhead a runway', () => {
  it('deepens the shared corridor when the arrival box extends further out', () => {
    // B's bottom sits 15px below A's, so a corridor 20px under A clears B's
    // anchor by 5 — half an arrowhead.
    const nodes: SpatialNode[] = [
      { id: 'A', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'A' },
      { id: 'B', type: 'text', x: 200, y: 0, width: 100, height: 115, text: 'B' },
    ]
    const routed = route(nodes, {
      id: 'e',
      fromNode: 'A',
      toNode: 'B',
      fromSide: 'bottom',
      toSide: 'bottom',
    })
    expect(finalSegmentLength(routed.path)).toBeGreaterThanOrEqual(ARROW_LENGTH_PX)
    // The corridor moved; the route did not gain a bend to get there.
    expect(routed.path).toHaveLength(4)
  })

  it('holds when the arrival box extends further out than the stub is deep', () => {
    // 40px deeper than A — past the 20px stub, so the naive corridor would
    // arrive from INSIDE the box and the approach would reverse.
    const nodes: SpatialNode[] = [
      { id: 'A', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'A' },
      { id: 'B', type: 'text', x: 200, y: 0, width: 100, height: 140, text: 'B' },
    ]
    const routed = route(nodes, {
      id: 'e',
      fromNode: 'A',
      toNode: 'B',
      fromSide: 'bottom',
      toSide: 'bottom',
    })
    expect(finalSegmentLength(routed.path)).toBeGreaterThanOrEqual(ARROW_LENGTH_PX)
  })

  it('leaves a route whose arrival box is the shallower one alone', () => {
    // A is the deeper box here, so the corridor already clears B generously
    // and nothing should be deepened.
    const nodes: SpatialNode[] = [
      { id: 'A', type: 'text', x: 0, y: 0, width: 100, height: 140, text: 'A' },
      { id: 'B', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'B' },
    ]
    const routed = route(nodes, {
      id: 'e',
      fromNode: 'A',
      toNode: 'B',
      fromSide: 'bottom',
      toSide: 'bottom',
    })
    expect(routed.path.map((p) => `${p.x},${p.y}`)).toEqual([
      '50,140',
      '50,160',
      '250,160',
      '250,100',
    ])
  })
})
