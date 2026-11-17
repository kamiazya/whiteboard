import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { commentAnchor } from './comment-geometry.js'

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'n', x: 100, y: 200, width: 80, height: 40, text: 'node' })],
  edges: [],
}

const comment = (target: Partial<CanvasComment> = {}): CanvasComment => ({
  id: 'c',
  x: 17,
  y: 29,
  text: 'a note',
  ...target,
})

const OWN = { x: 17, y: 29 }

// A comment may outlive its subject, so where it stands when nothing it
// names can be found is its own stored point: a pin at the origin would be a
// comment moved by a deletion nobody made to it.
describe('commentAnchor', () => {
  it('stands a comment with no target at its own point', () => {
    expect(commentAnchor(comment(), canvas)).toEqual(OWN)
  })

  it('stands a comment whose target node is gone at its own point', () => {
    expect(commentAnchor(comment({ targetNodeId: 'gone' }), canvas)).toEqual(OWN)
  })

  it('stands a comment whose target edge has no path at its own point', () => {
    const onEdge = comment({ targetEdgeId: 'e' })
    expect(commentAnchor(onEdge, canvas)).toEqual(OWN)
    expect(commentAnchor(onEdge, canvas, () => undefined)).toEqual(OWN)
    expect(commentAnchor(onEdge, canvas, () => [])).toEqual(OWN)
  })

  it('follows a target that resolves, so its own point is a fallback and not a constant', () => {
    expect(commentAnchor(comment({ targetNodeId: 'n' }), canvas)).not.toEqual(OWN)
    const path = [
      { x: 0, y: 100 },
      { x: 300, y: 100 },
    ]
    expect(commentAnchor(comment({ targetEdgeId: 'e' }), canvas, () => path)).toEqual({
      x: 17,
      y: 100,
    })
  })
})
