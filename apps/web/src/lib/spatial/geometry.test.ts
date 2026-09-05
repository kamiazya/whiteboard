import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  boxContains,
  cornerHitBoxes,
  edgeBandBoxes,
  findFreeSpot,
  hitTest,
  indexNodeBoxes,
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

  it('marks group frames as containers', () => {
    const c = canvas([{ id: 'g', type: 'group', x: 0, y: 0, width: 300, height: 200 }])
    expect(indexNodeBoxes(c)).toEqual([
      { id: 'g', container: true, box: { x: 0, y: 0, width: 300, height: 200 } },
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

  // A group frame is an unfilled container: a member under the pointer is
  // fully visible through it even when the frame paints later, so the
  // click must land on what the user sees. The frame stays reachable
  // through its padding area.
  it('prefers a member over a container frame painted above it', () => {
    const boxes = [
      { id: 'member', box: { x: 20, y: 20, width: 50, height: 50 } },
      { id: 'frame', container: true, box: { x: 0, y: 0, width: 200, height: 200 } },
    ]
    expect(hitTest(boxes, { x: 40, y: 40 })).toBe('member')
    expect(hitTest(boxes, { x: 150, y: 150 })).toBe('frame')
  })

  it('falls back to the topmost container when only containers are hit', () => {
    const boxes = [
      { id: 'outer', container: true, box: { x: 0, y: 0, width: 300, height: 300 } },
      { id: 'inner', container: true, box: { x: 50, y: 50, width: 100, height: 100 } },
    ]
    expect(hitTest(boxes, { x: 80, y: 80 })).toBe('inner')
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
  it('draws CORNERS only, sized inversely to zoom so they stay constant on screen', () => {
    const box = { x: 0, y: 0, width: 100, height: 100 }
    const handles = resizeHandleBoxes(box, 2)
    // Edge-midpoint handles are gone as chrome: the whole edge is the grab
    // (edgeBandBoxes below), so only the corners need a visible marker.
    expect(handles.map((h) => h.kind)).toEqual(['nw', 'ne', 'se', 'sw'])
    for (const h of handles) {
      expect(h.box.width).toBeCloseTo(8 / 2)
    }
  })
})

describe('cornerHitBoxes', () => {
  it('centers a hit box of the requested SCREEN size on each corner', () => {
    const box = { x: 0, y: 0, width: 100, height: 100 }
    const hits = cornerHitBoxes(box, 2, 24)
    expect(hits.map((h) => h.kind)).toEqual(['nw', 'ne', 'se', 'sw'])
    for (const h of hits) {
      expect(h.box.width).toBeCloseTo(12) // 24 screen px at zoom 2
    }
    const se = hits.find((h) => h.kind === 'se')
    if (se === undefined) throw new Error('missing se')
    expect(se.box.x + se.box.width / 2).toBeCloseTo(100)
    expect(se.box.y + se.box.height / 2).toBeCloseTo(100)
  })
})

describe('edgeBandBoxes', () => {
  const box = { x: 0, y: 0, width: 100, height: 100 }

  it('lays a band of the requested thickness along each edge, centered on it', () => {
    const bands = edgeBandBoxes(box, 1, 16, 24)
    expect(bands.map((b) => b.kind)).toEqual(['n', 'e', 's', 'w'])
    const east = bands.find((b) => b.kind === 'e')
    if (east === undefined) throw new Error('missing e')
    expect(east.box.x + east.box.width / 2).toBeCloseTo(100)
    expect(east.box.width).toBeCloseTo(16)
  })

  it('stops each band short of the corner hit zones, so corners always win their ground', () => {
    const bands = edgeBandBoxes(box, 1, 16, 24)
    const north = bands.find((b) => b.kind === 'n')
    if (north === undefined) throw new Error('missing n')
    // Corner hits are 24px squares centered on (0,0)/(100,0): the band must
    // start after the nw zone (12) and end before the ne zone (100-12).
    expect(north.box.x).toBeCloseTo(12)
    expect(north.box.x + north.box.width).toBeCloseTo(88)
  })

  it('never inverts on a node smaller than two corner zones', () => {
    const tiny = { x: 0, y: 0, width: 20, height: 20 }
    for (const band of edgeBandBoxes(tiny, 1, 16, 24)) {
      expect(band.box.width).toBeGreaterThanOrEqual(0)
      expect(band.box.height).toBeGreaterThanOrEqual(0)
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
  it('stays inside the visible area while it has room, so creating never pans the canvas', () => {
    const size = { width: 200, height: 100 }
    // A column of notes filling the cascade's diagonal path.
    const occupied = Array.from({ length: 13 }, (_, i) => ({
      x: 400 + i * 24 - 100,
      y: 300 + i * 24 - 50,
      width: 200,
      height: 100,
    }))
    const visible = { x: 0, y: 0, width: 800, height: 600 }
    const spot = findFreeSpot({ x: 400, y: 300 }, size, occupied, visible)
    // The unbounded cascade would have walked to (712,612) — its box runs
    // past the visible bottom, so the viewport would have to chase it.
    expect(spot.x - size.width / 2).toBeGreaterThanOrEqual(visible.x)
    expect(spot.y - size.height / 2).toBeGreaterThanOrEqual(visible.y)
    expect(spot.x + size.width / 2).toBeLessThanOrEqual(visible.x + visible.width)
    expect(spot.y + size.height / 2).toBeLessThanOrEqual(visible.y + visible.height)
  })

  it('uses a straight column when the visible area is too narrow for the diagonal', () => {
    const size = { width: 200, height: 100 }
    // Phone-shaped: one note wide, many notes tall.
    const visible = { x: 0, y: 0, width: 240, height: 700 }
    const occupied = [{ x: 20, y: 300, width: 200, height: 100 }]
    const spot = findFreeSpot({ x: 120, y: 350 }, size, occupied, visible)
    expect(spot.x - size.width / 2).toBeGreaterThanOrEqual(visible.x)
    expect(spot.x + size.width / 2).toBeLessThanOrEqual(visible.x + visible.width)
    expect(spot.y + size.height / 2).toBeLessThanOrEqual(visible.y + visible.height)
  })

  it('falls back to the plain cascade once the visible area is genuinely full', () => {
    const size = { width: 200, height: 100 }
    // Wall-to-wall: nothing inside `visible` can hold another box.
    const occupied = [{ x: -1000, y: -1000, width: 4000, height: 4000 }]
    const visible = { x: 0, y: 0, width: 800, height: 600 }
    const withVisible = findFreeSpot({ x: 400, y: 300 }, size, occupied, visible)
    const without = findFreeSpot({ x: 400, y: 300 }, size, occupied)
    expect(withVisible).toEqual(without)
  })
})
