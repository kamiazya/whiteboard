import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import {
  boxContains,
  findFreeSpot,
  hitTest,
  indexNodeBoxes,
  polylineMidpoint,
  resizeBoxByDelta,
  resizeHandleBoxes,
} from './geometry.js'

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

describe('resizeBoxByDelta', () => {
  const box = { x: 0, y: 0, width: 100, height: 100 }

  it('grows the se corner, leaving the opposite (nw) corner fixed', () => {
    expect(resizeBoxByDelta(box, 'se', 10, 20)).toEqual({ x: 0, y: 0, width: 110, height: 120 })
  })

  it('growing the nw corner shifts the origin so the opposite (se) corner stays fixed', () => {
    expect(resizeBoxByDelta(box, 'nw', -10, -20)).toEqual({
      x: -10,
      y: -20,
      width: 110,
      height: 120,
    })
  })

  it('clamps a shrink so width/height never go negative', () => {
    expect(resizeBoxByDelta(box, 'se', -500, -500)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('e only affects width, not y/height', () => {
    expect(resizeBoxByDelta(box, 'e', 15, 999)).toEqual({ x: 0, y: 0, width: 115, height: 100 })
  })
})

describe('findFreeSpot', () => {
  const size = { width: 200, height: 100 }

  it('returns the preferred point when nothing is occupied', () => {
    expect(findFreeSpot({ x: 500, y: 300 }, size, [])).toEqual({ x: 500, y: 300 })
  })

  it('cascades to a non-overlapping point when the preferred box collides', () => {
    const occupied = [{ x: 400, y: 250, width: 200, height: 100 }]
    const spot = findFreeSpot({ x: 500, y: 300 }, size, occupied)
    const box = { x: spot.x - size.width / 2, y: spot.y - size.height / 2, ...size }
    const overlaps =
      box.x < occupied[0].x + occupied[0].width &&
      box.x + box.width > occupied[0].x &&
      box.y < occupied[0].y + occupied[0].height &&
      box.y + box.height > occupied[0].y
    expect(overlaps).toBe(false)
    expect(spot).not.toEqual({ x: 500, y: 300 })
  })

  it('is deterministic: same inputs produce the same output', () => {
    const occupied = [{ x: 400, y: 250, width: 200, height: 100 }]
    expect(findFreeSpot({ x: 500, y: 300 }, size, occupied)).toEqual(
      findFreeSpot({ x: 500, y: 300 }, size, occupied),
    )
  })

  it('is total: terminates and returns a finite point on a densely packed field', () => {
    const occupied = Array.from({ length: 200 }, (_, i) => ({
      x: i * 4,
      y: i * 4,
      width: 200,
      height: 100,
    }))
    const spot = findFreeSpot({ x: 500, y: 300 }, size, occupied)
    expect(Number.isFinite(spot.x)).toBe(true)
    expect(Number.isFinite(spot.y)).toBe(true)
  })
})

describe('polylineMidpoint', () => {
  it('returns the arc-length midpoint of a two-segment path', () => {
    // Segments of length 10 then 30: midpoint is 20 along, i.e. 10 into segment 2.
    const path = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 30 },
    ]
    expect(polylineMidpoint(path)).toEqual({ x: 10, y: 10 })
  })

  it('degrades on degenerate paths instead of throwing', () => {
    expect(polylineMidpoint([])).toEqual({ x: 0, y: 0 })
    expect(polylineMidpoint([{ x: 3, y: 4 }])).toEqual({ x: 3, y: 4 })
    expect(
      polylineMidpoint([
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ]),
    ).toEqual({ x: 5, y: 5 })
  })
})
