// A frozen (bystander) edge must not MOVE mid-drag. Freezing sides alone
// is not enough: anchor positions are fractions of a (node, side) group,
// so a carried edge re-siding onto the same side mid-gesture used to
// re-fraction the bystander's anchor — a stationary edge visibly sliding
// along its node. Overrides can now pin the committed anchor points too.

import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors } from './spatial-edges.js'

// N -> T is the stationary bystander; M carries edge C. At M's committed
// position C arrives at T's bottom; dragged below-left, C re-sides onto
// T's LEFT — the side the bystander already occupies.
const N: SpatialNode = textNode({ id: 'N', x: 0, y: 0, width: 100, height: 100, text: '' })
const T: SpatialNode = textNode({ id: 'T', x: 300, y: 0, width: 100, height: 100, text: '' })
// Dragged to directly LEFT of T: the zero-bend facing pair (right->left)
// outranks the crowding tie-break, so C must join the occupied side.
const M_DRAGGED: SpatialNode = textNode({ id: 'M', x: 50, y: 0, width: 100, height: 100, text: '' })
const EDGES: CanvasEdge[] = [
  { id: 'F', from: { node: 'N' }, to: { node: 'T' } },
  { id: 'C', from: { node: 'M' }, to: { node: 'T' } },
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

  // The mirror of the case above: the carried edge joins the side the
  // bystander LEAVES from, so only the pin's from-half can hold it still.
  it('a pinned bystander keeps its committed SOURCE anchor when a carried edge joins that side', () => {
    const edges: CanvasEdge[] = [
      { id: 'F', from: { node: 'T' }, to: { node: 'N' } },
      { id: 'C', from: { node: 'T' }, to: { node: 'M' } },
    ]
    const committed = assignEdgeAnchors(
      [N, T, { ...M_DRAGGED, x: 300, y: 300 }],
      edges,
      'orthogonal',
    )
    const f = committed.get('F')
    expect([f?.fromSide, f?.toSide]).toEqual(['left', 'right'])

    const live = assignEdgeAnchors(
      [N, T, M_DRAGGED],
      edges,
      'orthogonal',
      new Map([
        [
          'F',
          {
            fromSide: 'left' as const,
            toSide: 'right' as const,
            from: f?.from,
            fromLaneDepth: f?.fromLaneDepth,
            to: f?.to,
            toLaneDepth: f?.toLaneDepth,
          },
        ],
        ['C', { fromSide: 'left' as const, toSide: 'right' as const }],
      ]),
    )
    expect(live.get('C')?.fromSide).toBe('left')
    expect(live.get('F')?.from).toEqual(f?.from)
    expect(live.get('F')?.fromLaneDepth).toBe(f?.fromLaneDepth)
    expect(live.get('C')?.from).not.toEqual(live.get('F')?.from)
  })

  // A pin is partial: a drag commits the end it moved and leaves the other
  // to be placed. Alignment slides BOTH ends of a lone facing pair onto one
  // lane, so an edge pinned at one end only must be kept out of it, or its
  // unpinned end slides while the pinned one holds.
  it('an edge pinned at one end only is not slid onto a shared lane', () => {
    const a = textNode({ id: 'A', x: 0, y: 0, width: 100, height: 100, text: '' })
    const b = textNode({ id: 'B', x: 300, y: 40, width: 100, height: 100, text: '' })
    const edges: CanvasEdge[] = [{ id: 'E', from: { node: 'A' }, to: { node: 'B' } }]
    const free = assignEdgeAnchors([a, b], edges, 'orthogonal').get('E')
    expect([free?.fromSide, free?.toSide]).toEqual(['right', 'left'])
    // Unpinned, the pair is slid onto one lane inside the overlap of the two
    // sides: a straight segment rather than a jog between the midpoints.
    expect(free?.from).toBeDefined()
    expect(free?.from?.y).toBe(free?.to?.y)

    const pinnedTo = { x: 300, y: 90 }
    const live = assignEdgeAnchors(
      [a, b],
      edges,
      'orthogonal',
      new Map([['E', { fromSide: 'right' as const, toSide: 'left' as const, to: pinnedTo }]]),
    ).get('E')
    expect(live?.to).toEqual(pinnedTo)
    // The free end keeps the fan-out pass's own point: its side's midpoint.
    expect(live?.from).toEqual({ x: 100, y: 50 })
  })
})
