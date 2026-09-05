// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { type AlignableBox, alignableBoxesOf, alignBoxes, distributeBoxes } from './align.js'

const box = (id: string, x: number, y: number, width = 100, height = 50): AlignableBox => ({
  id,
  x,
  y,
  width,
  height,
})

describe('alignBoxes', () => {
  // Three boxes of DIFFERENT sizes: an implementation that aligns by
  // position alone passes 'left' but fails 'right' and 'center-x'.
  const spread = [box('a', 0, 0, 100, 50), box('b', 40, 200, 60, 80), box('c', 300, 90, 20, 20)]

  it('aligns to the leftmost edge', () => {
    expect(alignBoxes(spread, 'left')).toEqual([
      { id: 'b', x: 0, y: 200 },
      { id: 'c', x: 0, y: 90 },
    ])
  })

  it('aligns to the rightmost edge, accounting for width', () => {
    // Rightmost edge is c's 300 + 20 = 320.
    expect(alignBoxes(spread, 'right')).toEqual([
      { id: 'a', x: 220, y: 0 },
      { id: 'b', x: 260, y: 200 },
    ])
  })

  it('centres on the selection bounding box, accounting for width', () => {
    // Bounds 0..320 → centre 160; each box lands at 160 - width/2.
    expect(alignBoxes(spread, 'center-x')).toEqual([
      { id: 'a', x: 110, y: 0 },
      { id: 'b', x: 130, y: 200 },
      { id: 'c', x: 150, y: 90 },
    ])
  })

  it('aligns to the top edge', () => {
    expect(alignBoxes(spread, 'top')).toEqual([
      { id: 'b', x: 40, y: 0 },
      { id: 'c', x: 300, y: 0 },
    ])
  })

  it('aligns to the bottom edge, accounting for height', () => {
    // Bottom-most edge is b's 200 + 80 = 280.
    expect(alignBoxes(spread, 'bottom')).toEqual([
      { id: 'a', x: 0, y: 230 },
      { id: 'c', x: 300, y: 260 },
    ])
  })

  it('centres vertically on the selection bounding box', () => {
    // Bounds 0..280 → centre 140.
    expect(alignBoxes(spread, 'center-y')).toEqual([
      { id: 'a', x: 0, y: 115 },
      { id: 'b', x: 40, y: 100 },
      { id: 'c', x: 300, y: 130 },
    ])
  })

  it('reports only the boxes that actually move', () => {
    // 'a' is already flush left, so it must not appear — an empty batch is
    // what keeps an already-aligned selection out of the undo history.
    const moves = alignBoxes(spread, 'left')
    expect(moves.map((move) => move.id)).not.toContain('a')
  })

  it('is a no-op on an already-aligned selection', () => {
    const aligned = [box('a', 10, 0), box('b', 10, 100)]
    expect(alignBoxes(aligned, 'left')).toEqual([])
  })

  it('needs two boxes: fewer is a no-op, never a throw', () => {
    expect(alignBoxes([], 'left')).toEqual([])
    expect(alignBoxes([box('a', 5, 5)], 'left')).toEqual([])
  })

  it('rounds to integers, matching the canvas schema', () => {
    // Bounds 0..101 → centre 50.5; a 3-wide box wants 49, not 49.
    const odd = [box('a', 0, 0, 3, 3), box('b', 98, 50, 3, 3)]
    for (const move of alignBoxes(odd, 'center-x')) {
      expect(Number.isInteger(move.x)).toBe(true)
      expect(Number.isInteger(move.y)).toBe(true)
    }
  })
})

describe('distributeBoxes', () => {
  it('equalises the GAPS between boxes, not their centres', () => {
    // Widths 100/60/20, span 0..320 → free = 320 - 180 = 140, gap = 70.
    // a stays at 0; b at 100+70=170; c at 170+60+70=300 (already there).
    const boxes = [box('a', 0, 0, 100, 50), box('b', 40, 0, 60, 50), box('c', 300, 0, 20, 50)]
    expect(distributeBoxes(boxes, 'horizontal')).toEqual([{ id: 'b', x: 170, y: 0 }])
  })

  it('distributes vertically the same way', () => {
    const boxes = [box('a', 0, 0, 50, 100), box('b', 0, 30, 50, 60), box('c', 0, 300, 50, 20)]
    // span 0..320, free = 320 - 180 = 140, gap = 70 → b at 100+70 = 170.
    expect(distributeBoxes(boxes, 'vertical')).toEqual([{ id: 'b', x: 0, y: 170 }])
  })

  it('orders by position, not by the order the ids arrive in', () => {
    const shuffled = [box('c', 300, 0, 20, 50), box('a', 0, 0, 100, 50), box('b', 40, 0, 60, 50)]
    expect(distributeBoxes(shuffled, 'horizontal')).toEqual([{ id: 'b', x: 170, y: 0 }])
  })

  it('leaves the two outermost boxes where they are', () => {
    const boxes = [box('a', 0, 0), box('b', 10, 0), box('c', 500, 0)]
    const moved = distributeBoxes(boxes, 'horizontal').map((move) => move.id)
    expect(moved).not.toContain('a')
    expect(moved).not.toContain('c')
  })

  it('needs three boxes: fewer is a no-op, never a throw', () => {
    expect(distributeBoxes([], 'horizontal')).toEqual([])
    expect(distributeBoxes([box('a', 0, 0)], 'horizontal')).toEqual([])
    expect(distributeBoxes([box('a', 0, 0), box('b', 100, 0)], 'horizontal')).toEqual([])
  })

  it('stays total when the boxes overlap more than the span allows', () => {
    // Sum of widths (300) exceeds the span (0..100 = 100+width) — the gap
    // goes negative rather than the function throwing or bailing.
    const crowded = [box('a', 0, 0, 100, 50), box('b', 0, 0, 100, 50), box('c', 0, 0, 100, 50)]
    const moves = distributeBoxes(crowded, 'horizontal')
    for (const move of moves) expect(Number.isFinite(move.x)).toBe(true)
  })
})

describe('alignableBoxesOf', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0, width: 100, height: 50, extra: 'dropped' },
    { id: 'b', x: 40, y: 0, width: 60, height: 50 },
    { id: 'c', x: 300, y: 0, width: 20, height: 50 },
  ]

  it('returns only the member boxes, in canvas (nodes) order', () => {
    expect(alignableBoxesOf(nodes, ['c', 'a'])).toEqual([
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'c', x: 300, y: 0, width: 20, height: 50 },
    ])
  })

  it('projects to the id+x+y+width+height shape, dropping other node fields', () => {
    expect(alignableBoxesOf(nodes, ['a'])).toEqual([
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
    ])
  })

  it('returns an empty list for no member ids', () => {
    expect(alignableBoxesOf(nodes, [])).toEqual([])
  })
})
