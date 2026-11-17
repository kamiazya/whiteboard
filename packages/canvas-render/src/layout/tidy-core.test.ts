import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { fakeLayoutCore } from '../test-utils/index.js'
import { testLayoutCore } from '../test-utils/test-layout-core.js'
import { type TidyNode, tidyBoxes, tidyNodes } from '../tidy.js'

const core = testLayoutCore()

const box = (id: string, x: number, y: number, width = 100, height = 40): TidyNode => ({
  id,
  frame: false,
  x,
  y,
  width,
  height,
})

describe('tidy through the Rust core', () => {
  it('answers the boxes that move and none that already sit on their row', () => {
    const board = [box('a', 0, 0), box('b', 200, 3), box('c', 400, 0)]
    expect(tidyNodes(board, { core })).toEqual([{ id: 'b', x: 200, y: 0 }])
    expect(tidyNodes([box('a', 0, 0), box('b', 200, 0)], { core })).toEqual([])
  })

  it('holds a locked box where it is and routes the rest around it', () => {
    const board = [box('a', 0, 0), box('b', 200, 3)]
    expect(tidyNodes(board, { core, locked: (id) => id === 'b' })).toEqual([
      { id: 'a', x: 0, y: 3 },
    ])
  })

  it('moves only the unit roots a scope names', () => {
    const board = [box('a', 0, 0), box('b', 200, 3), box('c', 400, 5)]
    expect(tidyNodes(board, { core, scope: new Set(['c']) }).map((m) => m.id)).toEqual(['c'])
  })

  it('reads the ends an edge names, one of them a node the board does not hold', () => {
    const board = [box('a', 0, 0), box('b', 200, 3)]
    const edges = [
      { from: { node: 'a' }, to: { node: 'ghost' } },
      { from: { node: 'a' }, to: { node: 'b' } },
    ]
    expect(tidyNodes(board, { core, edges })).toEqual([{ id: 'b', x: 200, y: 0 }])
  })

  it('carries the new size of a frame that grew to hold its members', () => {
    const frame = { ...box('f', 0, 0, 100, 100), frame: true }
    const moves = tidyNodes([frame, box('m', 10, 10, 90, 50)], { core })
    expect(moves.find((m) => m.id === 'f')).toMatchObject({
      width: 154,
      height: expect.any(Number),
    })
  })

  it('leaves a box with a non-finite coordinate out of the board rather than tidying nothing', () => {
    const board = [box('a', 0, 0), box('b', 200, 3), box('bad', Number.NaN, 0)]
    expect(tidyNodes(board, { core })).toEqual([{ id: 'b', x: 200, y: 0 }])
  })

  it('answers a board past the core cap as one that moves nothing, and says it refused', () => {
    const many = Array.from({ length: 4200 }, (_, i) => box(`n${i}`, 0, 0))
    const refusals: unknown[] = []
    expect(tidyNodes(many, { core, onRefused: (r) => refusals.push(r) })).toEqual([])
    expect(refusals).toHaveLength(1)
  })

  it('does not say it refused a board the core answered with no moves', () => {
    const refusals: unknown[] = []
    const board = [box('a', 0, 0), box('b', 200, 0)]
    expect(tidyNodes(board, { core, onRefused: (r) => refusals.push(r) })).toEqual([])
    expect(refusals).toEqual([])
  })

  it('drops a move the core answers for a locked box', () => {
    const stub = fakeLayoutCore({
      query: {
        layoutQuery: () => ({
          moves: [
            ['a', 1, 1],
            ['b', 2, 2],
          ],
        }),
      },
    })
    const board = [box('a', 0, 0), box('b', 200, 3)]
    expect(tidyNodes(board, { core: stub, locked: (id) => id === 'b' })).toEqual([
      { id: 'a', x: 1, y: 1 },
    ])
  })

  it('reads a stored node as a frame by its kind', () => {
    const boxes = tidyBoxes([
      textNode({ id: 't', x: 1, y: 2, width: 3, height: 4, text: 'x' }),
      groupNode({ id: 'g', x: 5, y: 6, width: 7, height: 8 }),
    ])
    expect(boxes.map((b) => [b.id, b.frame])).toEqual([
      ['t', false],
      ['g', true],
    ])
  })
})
