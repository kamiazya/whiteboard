import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { inkPlace, stepTraversal, traversalStops } from './traversal-order.js'

const a = textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'A' })
const b = textNode({ id: 'b', x: 200, y: 0, width: 100, height: 50, text: 'B' })
const c = textNode({ id: 'c', x: 0, y: 200, width: 100, height: 50, text: 'C' })

const board: SpatialCanvas = {
  // Stored out of reading order on purpose: the walk follows the board, not the array.
  nodes: [c, b, a],
  edges: [
    { id: 'bc', from: { node: 'b' }, to: { node: 'c' } },
    { id: 'ab', from: { node: 'a' }, to: { node: 'b' } },
  ],
  lines: [
    {
      id: 'free',
      from: { kind: 'point', point: { x: 0, y: 0 } },
      to: { kind: 'point', point: { x: 9, y: 9 } },
    },
    { id: 'toA', from: { kind: 'point', point: { x: 0, y: 0 } }, to: { kind: 'node', node: 'a' } },
  ],
}

const unlocked = { isNodeLocked: () => false, isInkLocked: () => false }

describe('traversalStops', () => {
  it('reads each node, then the connections and lines it starts, free ink last', () => {
    const stops = traversalStops(board, unlocked).map((stop) => `${stop.kind}:${stop.id}`)
    expect(stops).toEqual(['node:a', 'ink:ab', 'ink:toA', 'node:b', 'ink:bc', 'node:c', 'ink:free'])
  })

  it('records the node a connection was reached from', () => {
    const stop = traversalStops(board, unlocked).find((entry) => entry.id === 'bc')
    expect(stop).toEqual({ kind: 'ink', id: 'bc', anchorId: 'b' })
  })

  it('skips locked nodes and locked ink but keeps a locked node’s connections in its place', () => {
    const stops = traversalStops(board, {
      isNodeLocked: (id) => id === 'a',
      isInkLocked: (id) => id === 'bc',
    }).map((stop) => stop.id)
    expect(stops).toEqual(['ab', 'toA', 'b', 'c', 'free'])
  })
})

describe('stepTraversal', () => {
  const stops = traversalStops(board, unlocked)

  it('steps forward and back from a connection and does not wrap', () => {
    expect(stepTraversal(stops, { kind: 'ink', id: 'ab' }, 1)?.id).toBe('toA')
    expect(stepTraversal(stops, { kind: 'ink', id: 'ab' }, -1)?.id).toBe('a')
    expect(stepTraversal(stops, { kind: 'ink', id: 'free' }, 1)).toBeUndefined()
    expect(stepTraversal(stops, { kind: 'node', id: 'a' }, -1)).toBeUndefined()
  })

  it('starts at either end with nothing selected', () => {
    expect(stepTraversal(stops, null, 1)?.id).toBe('a')
    expect(stepTraversal(stops, null, -1)?.id).toBe('free')
  })
})

describe('inkPlace', () => {
  it('counts a connection among the ink in the order Tab reaches it', () => {
    expect(inkPlace(board, 'bc')).toEqual({ place: 3, of: 4 })
    expect(inkPlace(board, 'missing')).toBeUndefined()
  })
})
