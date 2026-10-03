/**
 * Where coordinate-less nodes land is a promise to the agent that placed them: it can
 * predict the spot without asking. The board-level cursor and the prevailing-width vote
 * are reached elsewhere only through broad `wb_canvas_edit` cases, where a shifted
 * anchor reads as a slightly odd canvas. `placeWithin` has its own property test.
 */
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { PlacementCursor, prevailingWidth } from './canvas-edit-placement.js'

const box = (id: string, x: number, y: number, width: number, height: number) =>
  textNode({ id, x, y, width, height, text: id })

describe('PlacementCursor', () => {
  it('starts at the origin on an empty board', () => {
    expect(new PlacementCursor().next([], 100, 50)).toEqual({ x: 0, y: 0 })
  })

  it('anchors one gutter below the lowest content, at the left-most edge', () => {
    // bottoms are 60 and 130; lefts are 10 and 300 -> (10, 130 + 40)
    const board = [box('a', 10, 0, 100, 60), box('b', 300, 30, 100, 100)]
    expect(new PlacementCursor().next(board, 100, 50)).toEqual({ x: 10, y: 170 })
  })

  it('steps a width plus a gutter per node and wraps after four, under the tallest of the row', () => {
    const cursor = new PlacementCursor()
    const at = Array.from({ length: 6 }, (_, i) => cursor.next([], 100, i === 1 ? 80 : 50))
    expect(at.map((p) => p.x)).toEqual([0, 140, 280, 420, 0, 140])
    expect(at.map((p) => p.y)).toEqual([0, 0, 0, 0, 120, 120])
  })

  it('anchors once: nodes the batch has added do not move the origin', () => {
    const cursor = new PlacementCursor()
    cursor.next([], 100, 50)
    expect(cursor.next([box('later', 500, 500, 100, 100)], 100, 50)).toEqual({ x: 140, y: 0 })
  })
})

describe('prevailingWidth', () => {
  it('is undefined when the board has no boxes, and groups do not vote', () => {
    const group = (id: string) => groupNode({ id, x: 0, y: 0, width: 900, height: 900 })
    expect(prevailingWidth([])).toBeUndefined()
    expect(prevailingWidth([group('g1')])).toBeUndefined()
    expect(prevailingWidth([group('g1'), group('g2'), box('a', 0, 0, 200, 40)])).toBe(200)
  })

  it('is the commonest width, the wider on a tie', () => {
    const w = (id: string, width: number) => box(id, 0, 0, width, 40)
    expect(prevailingWidth([w('a', 200), w('b', 200), w('c', 300)])).toBe(200)
    expect(prevailingWidth([w('a', 200), w('b', 300)])).toBe(300)
    expect(prevailingWidth([w('a', 300), w('b', 200)])).toBe(300)
    expect(prevailingWidth([w('a', 300), w('b', 200), w('c', 200), w('d', 300)])).toBe(300)
  })
})
