// A live drag freezes the resting edges' sides through an override map, but
// an end whose side the author NAMED keeps that side even then: the override
// carries what the last render resolved, and a name outranks a resolution.
// The frozen pair is merged per edge, so each edge must read its OWN ends —
// reading another edge's would hand the override a side nobody named.

import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { expect, it } from 'vitest'
import { node } from '../../test-utils/spatial-node.js'
import { assignEdgeAnchors } from './spatial-edges.js'

const NODES = [node('a', 0, 0, 100, 60), node('b', 300, 0, 100, 60), node('c', 0, 300, 100, 60)]

it('keeps an end the author named over the side a live-drag override froze', () => {
  // Listed first, unnamed: the edge an override must not read in its place.
  const unnamed: CanvasEdge = { id: 'c-b', from: { node: 'c' }, to: { node: 'b' } }
  const named: CanvasEdge = { id: 'a-b', from: { node: 'a', side: 'top' }, to: { node: 'b' } }
  const frozen = new Map([['a-b', { fromSide: 'bottom' as const, toSide: 'left' as const }]])

  const anchors = assignEdgeAnchors(NODES, [unnamed, named], 'orthogonal', frozen)

  expect(anchors.get('a-b')).toMatchObject({ fromSide: 'top', toSide: 'left' })
})
