// A frozen (bystander) edge must not MOVE mid-drag. Freezing sides alone
// is not enough: anchor positions are fractions of a (node, side) group,
// so a carried edge re-siding onto the same side mid-gesture used to
// re-fraction the bystander's anchor — a stationary edge visibly sliding
// along its node. Overrides can now pin the committed anchor points too.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors } from './spatial-edges.js'

// N -> T is the stationary bystander; M carries edge C. At M's committed
// position C arrives at T's bottom; dragged below-left, C re-sides onto
// T's LEFT — the side the bystander already occupies.
const N: SpatialNode = { id: 'N', type: 'text', x: 0, y: 0, width: 100, height: 100, text: '' }
const T: SpatialNode = { id: 'T', type: 'text', x: 300, y: 0, width: 100, height: 100, text: '' }
// Dragged to directly LEFT of T: the zero-bend facing pair (right->left)
// outranks the crowding tie-break, so C must join the occupied side.
const M_DRAGGED: SpatialNode = {
  id: 'M',
  type: 'text',
  x: 50,
  y: 0,
  width: 100,
  height: 100,
  text: '',
}
const EDGES: CanvasEdge[] = [
  { id: 'F', fromNode: 'N', toNode: 'T' },
  { id: 'C', fromNode: 'M', toNode: 'T' },
]

describe('live-drag anchor freeze', () => {
  it('a pinned bystander keeps its committed anchor when a carried edge joins its side', () => {
    // Committed: F alone on T's left, anchored at the side midpoint (M
    // sits below T, its edge arriving at T's bottom).
    const committed = assignEdgeAnchors(
      [N, T, { ...M_DRAGGED, x: 300, y: 300 }],
      EDGES,
      'orthogonal',
    )
    const f = committed.get('F')
    expect([f?.fromSide, f?.toSide]).toEqual(['right', 'left'])
    expect(f?.to).toEqual({ x: 300, y: 50 })

    // Mid-drag frame: C has re-sided onto T's left (sides-only override,
    // as a freshly re-sided carried edge). F's override pins its committed
    // anchors alongside its sides.
    const live = assignEdgeAnchors(
      [N, T, M_DRAGGED],
      EDGES,
      'orthogonal',
      new Map([
        [
          'F',
          {
            fromSide: f?.fromSide ?? ('right' as const),
            toSide: f?.toSide ?? ('left' as const),
            from: f?.from,
            fromLaneDepth: f?.fromLaneDepth,
            to: f?.to,
            toLaneDepth: f?.toLaneDepth,
          },
        ],
        ['C', { fromSide: 'right' as const, toSide: 'left' as const }],
      ]),
    )
    const liveC = live.get('C')
    expect(liveC?.toSide).toBe('left')
    const liveF = live.get('F')
    expect(liveF?.to).toEqual(f?.to)
    expect(liveF?.from).toEqual(f?.from)
    expect(liveF?.toLaneDepth).toBe(f?.toLaneDepth)
    // The carried newcomer lands elsewhere on the side, not on the pin.
    expect(liveC?.to).not.toEqual(liveF?.to)
  })
})
