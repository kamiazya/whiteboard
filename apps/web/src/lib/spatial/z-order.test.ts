// @vitest-environment node

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { reorderNodes } from './z-order.js'

// Array order IS z-order in JSON Canvas (last = topmost), so reorder is a
// pure array permutation: node objects stay reference-equal.
// forward/backward are OVERLAP-aware (user feedback 2026-08-09, tldraw
// semantics): the block steps over the nearest node it visually overlaps,
// because stepping over a non-overlapping neighbor changes nothing on
// screen and reads as the shortcut "not working".
describe('reorder-nodes', () => {
  /** Four nodes stacked on the same spot — everything overlaps. */
  function stackedCanvas(): SpatialCanvas {
    return {
      nodes: (['a', 'b', 'c', 'd'] as const).map((id) =>
        textNode({
          id,
          x: 0,
          y: 0,
          width: 80,
          height: 40,
          text: id,
        }),
      ),
      edges: [],
    }
  }
  const orderOf = (canvas: SpatialCanvas) => canvas.nodes.map((node) => node.id)

  it('forward steps over the nearest overlapping node above; backward mirrors', () => {
    const canvas = stackedCanvas()
    expect(orderOf(reorderNodes(canvas, ['b'], 'forward'))).toEqual(['a', 'c', 'b', 'd'])
    expect(orderOf(reorderNodes(canvas, ['b'], 'backward'))).toEqual(['b', 'a', 'c', 'd'])
    // The moved node object itself is reference-equal.
    const next = reorderNodes(canvas, ['b'], 'forward')
    expect(next.nodes[2]).toBe(canvas.nodes[1])
    expect(next.edges).toBe(canvas.edges)
  })

  it('forward/backward SKIP non-overlapping neighbors and land past the overlapping one', () => {
    // z-order a < b < c < d; spatially only a and d overlap (b, c live
    // far away). Forward from a must step over d directly — hopping over
    // b or c would change nothing visible.
    const canvas: SpatialCanvas = {
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 80, height: 40, text: 'a' }),
        textNode({ id: 'b', x: 500, y: 500, width: 80, height: 40, text: 'b' }),
        textNode({ id: 'c', x: 700, y: 500, width: 80, height: 40, text: 'c' }),
        textNode({ id: 'd', x: 40, y: 20, width: 80, height: 40, text: 'd' }),
      ],
      edges: [],
    }
    expect(orderOf(reorderNodes(canvas, ['a'], 'forward'))).toEqual(['b', 'c', 'd', 'a'])
    expect(orderOf(reorderNodes(canvas, ['d'], 'backward'))).toEqual(['d', 'a', 'b', 'c'])
    // No overlapping node in the step direction → visually already on
    // top/bottom of its pile → no-op, even with array neighbors present.
    expect(reorderNodes(canvas, ['d'], 'forward')).toBe(canvas)
    expect(reorderNodes(canvas, ['b'], 'backward')).toBe(canvas)
  })

  it('touching edges do not count as overlap', () => {
    // b sits exactly flush against a's right edge — adjacent, not
    // overlapping, so forward has nothing to step over.
    const canvas: SpatialCanvas = {
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 80, height: 40, text: 'a' }),
        textNode({ id: 'b', x: 80, y: 0, width: 80, height: 40, text: 'b' }),
      ],
      edges: [],
    }
    expect(reorderNodes(canvas, ['a'], 'forward')).toBe(canvas)
  })

  it('front moves to the end of the array; back to the start (position-independent)', () => {
    const canvas = stackedCanvas()
    expect(orderOf(reorderNodes(canvas, ['b'], 'front'))).toEqual(['a', 'c', 'd', 'b'])
    expect(orderOf(reorderNodes(canvas, ['c'], 'back'))).toEqual(['c', 'a', 'b', 'd'])
  })

  it('a multi-selection moves as ONE block preserving its relative order', () => {
    const canvas = stackedCanvas()
    expect(orderOf(reorderNodes(canvas, ['d', 'a'], 'front'))).toEqual(['b', 'c', 'a', 'd'])
    expect(orderOf(reorderNodes(canvas, ['a', 'c'], 'back'))).toEqual(['a', 'c', 'b', 'd'])
    // Forward steps the block over the next overlapping non-member (a
    // member overlaps when ANY of its nodes intersects the candidate).
    expect(orderOf(reorderNodes(canvas, ['a', 'b'], 'forward'))).toEqual(['c', 'a', 'b', 'd'])
    expect(orderOf(reorderNodes(canvas, ['c', 'd'], 'backward'))).toEqual(['a', 'c', 'd', 'b'])
  })

  it('is total: extremes, unknown ids, and empty selections are no-ops returning the input', () => {
    const canvas = stackedCanvas()
    expect(reorderNodes(canvas, ['d'], 'forward')).toBe(canvas)
    expect(reorderNodes(canvas, ['a'], 'backward')).toBe(canvas)
    expect(reorderNodes(canvas, ['d'], 'front')).toBe(canvas)
    expect(reorderNodes(canvas, ['zzz'], 'front')).toBe(canvas)
    expect(reorderNodes(canvas, [], 'front')).toBe(canvas)
  })
})
