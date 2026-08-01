import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { boxContains, hitTest, indexNodeBoxes, resizeHandleBoxes } from './geometry.js'

function canvas(nodes: SpatialCanvas['nodes']): SpatialCanvas {
  return { nodes, edges: [] }
}

describe('indexNodeBoxes', () => {
  it('produces one box per node, in document order', () => {
    const c = canvas([
      { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi' },
      { id: 'b', type: 'file', x: 200, y: 0, width: 80, height: 40, file: 'x.png' },
    ])
    expect(indexNodeBoxes(c)).toEqual([
      { id: 'a', box: { x: 0, y: 0, width: 100, height: 50 } },
      { id: 'b', box: { x: 200, y: 0, width: 80, height: 40 } },
    ])
  })
})

describe('hitTest', () => {
  const boxes = [
    { id: 'a', box: { x: 0, y: 0, width: 100, height: 50 } },
    { id: 'b', box: { x: 200, y: 0, width: 80, height: 40 } },
  ]

  it('selects the node under the point, not one merely nearby', () => {
    expect(hitTest(boxes, { x: 10, y: 10 })).toBe('a')
    expect(hitTest(boxes, { x: 210, y: 10 })).toBe('b')
    // just outside a's box, close to it but not inside either box
    expect(hitTest(boxes, { x: 150, y: 10 })).toBeUndefined()
  })

  it('returns undefined for empty space and empty box lists', () => {
    expect(hitTest(boxes, { x: 500, y: 500 })).toBeUndefined()
    expect(hitTest([], { x: 0, y: 0 })).toBeUndefined()
  })

  it('returns the document-order-last (topmost painted) node when overlapping', () => {
    const overlapping = [
      { id: 'bottom', box: { x: 0, y: 0, width: 100, height: 100 } },
      { id: 'top', box: { x: 20, y: 20, width: 50, height: 50 } },
    ]
    expect(hitTest(overlapping, { x: 40, y: 40 })).toBe('top')
  })
})

describe('boxContains', () => {
  it('includes the edge (documented, pinned decision)', () => {
    const box = { x: 0, y: 0, width: 10, height: 10 }
    expect(boxContains(box, { x: 10, y: 10 })).toBe(true)
    expect(boxContains(box, { x: 0, y: 0 })).toBe(true)
    expect(boxContains(box, { x: 11, y: 5 })).toBe(false)
  })
})

describe('resizeHandleBoxes', () => {
  it('produces 8 handles sized inversely to zoom so they stay constant on screen', () => {
    const box = { x: 0, y: 0, width: 100, height: 100 }
    const handles = resizeHandleBoxes(box, 2)
    expect(handles).toHaveLength(8)
    for (const h of handles) {
      expect(h.box.width).toBeCloseTo(8 / 2)
    }
  })
})
