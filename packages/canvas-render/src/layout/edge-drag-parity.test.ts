// Two pins from the same field report (a node dropped overlapping its
// neighbour rendered differently mid-drag and after drop):
//
// 1. A facing opposing pair is only zero-bend when the sides actually face
//    each other — a pair whose boxes interpenetrate along the facing axis
//    (B's right edge past C's left edge) can never take it.
// 2. The live-drag overlay (frozen sides for resting edges, carried edges
//    re-sided per frame) must side carried edges through the same
//    optimizer the committed render uses, restricted to the carried set —
//    otherwise the drop swaps sides the preview never showed.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors } from './spatial-edges.js'

// The reported layout: A above, B below-left, C overlapping B's right side.
const NODES: SpatialNode[] = [
  { id: 'B', type: 'text', x: 100, y: 570, width: 200, height: 100, text: '' },
  { id: 'C', type: 'text', x: 280, y: 530, width: 200, height: 100, text: '' },
  { id: 'A', type: 'text', x: 100, y: 340, width: 200, height: 100, text: '' },
]
const EDGES: CanvasEdge[] = [
  { id: 'B-C', fromNode: 'B', toNode: 'C' },
  { id: 'A-B', fromNode: 'A', toNode: 'B', label: 'hoge' },
  { id: 'A-C', fromNode: 'A', toNode: 'C' },
]

describe('interpenetrating boxes', () => {
  it('never take the facing pair whose sides overlap along the normal axis', () => {
    // A single edge gets its initial sides verbatim (no optimizer at n=1):
    // B's right edge (x=300) is past C's left edge (x=280), so right->left
    // would route backwards into the overlap.
    const anchors = assignEdgeAnchors(NODES, [EDGES[0]!], 'orthogonal')
    const bc = anchors.get('B-C')
    expect([bc?.fromSide, bc?.toSide]).not.toEqual(['right', 'left'])
  })
})

describe('live-drag overlay parity', () => {
  it('sides carried edges exactly as the committed render will', () => {
    const committed = assignEdgeAnchors(NODES, EDGES, 'orthogonal')
    // The drag overlay freezes resting edges at their committed sides and
    // omits carried edges (here: both edges into the dragged node C).
    const frozen = new Map([
      [
        'A-B',
        {
          fromSide: committed.get('A-B')?.fromSide ?? ('top' as const),
          toSide: committed.get('A-B')?.toSide ?? ('top' as const),
        },
      ],
    ])
    const live = assignEdgeAnchors(NODES, EDGES, 'orthogonal', frozen)
    for (const id of ['B-C', 'A-C']) {
      const c = committed.get(id)
      const l = live.get(id)
      expect([id, l?.fromSide, l?.toSide]).toEqual([id, c?.fromSide, c?.toSide])
    }
  })
})
