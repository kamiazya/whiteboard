// The side-choice search scores its trials against UNALIGNED anchors, but
// the render draws aligned ones, so a configuration can score clean during
// the search and pick up real defects the moment the final pass aligns it.
// This canvas is the reported instance: A->B settled on top->bottom, which
// after alignment traced 267px of B's own border and wrapped 601px around
// three sides, while bottom->bottom — already in the edge's ranked candidate
// list — was strictly better on every tier. Neither number was visible to a
// search that never aligns, so the fix is the second, fully-aligned run
// `assignEdgeAnchors` makes over the settled configuration.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { pathLength } from '../../test-utils/routing-metrics.js'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const nodes: SpatialNode[] = [
  { id: 'A', type: 'text', x: 100, y: 570, width: 200, height: 100, text: 'A' },
  { id: 'B', type: 'text', x: 280, y: 520, width: 200, height: 100, text: 'B' },
  { id: 'T', type: 'text', x: 80, y: 360, width: 200, height: 110, text: 'T' },
]
const edges: CanvasEdge[] = [
  { id: 'A->B', fromNode: 'A', toNode: 'B' },
  { id: 'T->A', fromNode: 'T', toNode: 'A' },
  { id: 'T->B', fromNode: 'T', toNode: 'B' },
]

describe('a settled configuration is re-scored against the anchors it will be drawn with', () => {
  it('routes overlapping neighbours along their shared face instead of wrapping three sides', () => {
    const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
    const routed = routeEdge(nodes, edges[0] as CanvasEdge, 'orthogonal', anchors.get('A->B'))
    expect({
      sides: `${routed.fromSide}->${routed.toSide}`,
      length: Math.round(pathLength(routed.path)),
      bends: routed.path.length - 2,
    }).toEqual({ sides: 'bottom->bottom', length: 270, bends: 2 })
  })
})
