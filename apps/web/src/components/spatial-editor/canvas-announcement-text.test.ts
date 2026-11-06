import type { CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { freehandLine } from '../../lib/spatial/freehand.js'
import { canvasChangeMessage, selectionMessage, tidyMessage } from './canvas-announcement-text.js'

const a = textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' })
const b = textNode({ id: 'b', x: 200, y: 0, width: 100, height: 40, text: 'B' })
const c = textNode({ id: 'c', x: 400, y: 0, width: 100, height: 40, text: 'C' })
const empty: SpatialCanvas = { nodes: [], edges: [] }
const two: SpatialCanvas = { nodes: [a, b], edges: [] }

describe('what a canvas change sounds like', () => {
  it('a new note, a new frame and deleted nodes are each named', () => {
    expect(canvasChangeMessage(empty, { nodes: [a], edges: [] })).toBe('Note added')
    expect(
      canvasChangeMessage(empty, {
        nodes: [groupNode({ id: 'g', x: 0, y: 0, width: 50, height: 50 })],
        edges: [],
      }),
    ).toBe('Frame added')
    expect(canvasChangeMessage(two, empty)).toBe('Deleted 2 nodes')
    expect(canvasChangeMessage(two, { nodes: [a], edges: [] })).toBe('Deleted 1 node')
  })

  it('a frame that arrives around existing nodes says it framed them', () => {
    const frame = groupNode({ id: 'g', x: -10, y: -10, width: 340, height: 80 })
    expect(canvasChangeMessage(two, { nodes: [frame, a, b], edges: [] })).toBe('Framed 2 nodes')
  })

  it('a new edge says which two it joins', () => {
    const edge = { id: 'e', from: { node: 'a' }, to: { node: 'b' } } as const
    expect(canvasChangeMessage(two, { nodes: [a, b], edges: [edge] })).toBe('Connected A to B')
  })

  it('a move, a resize or an edit is silent', () => {
    expect(canvasChangeMessage(two, { nodes: [{ ...a, x: 5 }, b], edges: [] })).toBeUndefined()
  })

  it('a deleted drawing or line is named as a node deletion is', () => {
    const stroke = freehandLine(
      's',
      [
        { x: 0, y: 0 },
        { x: 20, y: 30 },
        { x: 40, y: 10 },
      ],
      1,
    ) as CanvasLine
    const ruled: CanvasLine = {
      id: 'l',
      from: { kind: 'point', point: { x: 0, y: 0 } },
      to: { kind: 'point', point: { x: 90, y: 0 } },
    }
    expect(canvasChangeMessage({ ...empty, lines: [stroke] }, { ...empty, lines: [] })).toBe(
      'Deleted 1 drawing',
    )
    expect(canvasChangeMessage({ ...empty, lines: [stroke, ruled] }, empty)).toBe('Deleted 2 lines')
    expect(canvasChangeMessage({ ...empty, lines: [ruled] }, empty)).toBe('Deleted 1 line')
  })

  it('drawings the eraser took are said to be erased', () => {
    const drawn = (id: string) =>
      freehandLine(
        id,
        [
          { x: 0, y: 0 },
          { x: 20, y: 30 },
          { x: 40, y: 10 },
        ],
        1,
      ) as CanvasLine
    expect(canvasChangeMessage({ ...empty, lines: [drawn('s'), drawn('t')] }, empty, true)).toBe(
      'Erased 2 drawings',
    )
  })

  it('several nodes at once are counted, not itemised', () => {
    expect(canvasChangeMessage(empty, { nodes: [a, b, c], edges: [] })).toBe('3 nodes added')
  })
})

describe('what a selection sounds like', () => {
  const board: SpatialCanvas = { nodes: [c, a, b], edges: [] }

  it('one node says its place in the order Tab walks', () => {
    expect(selectionMessage(board, ['b'], null)).toBe('Selected: B (2 of 3)')
  })

  it('several nodes are counted', () => {
    expect(selectionMessage(board, ['a', 'b'], null)).toBe('Selected 2 nodes')
  })

  it('a connection is named by what it joins, with its place among the ink', () => {
    const edge = { id: 'e', from: { node: 'a' }, to: { node: 'b' }, label: 'yes' } as const
    expect(selectionMessage({ ...board, edges: [edge] }, [], 'e')).toBe(
      'Selected: Connection from A to B: yes (1 of 1)',
    )
  })

  it('a line is called a line, never a connection', () => {
    const line = {
      id: 'l',
      from: { kind: 'node', node: 'a' },
      to: { kind: 'point', point: { x: 0, y: 0 } },
    } as const
    expect(selectionMessage({ ...board, lines: [line] }, [], 'l')).toBe(
      'Selected: Line from A to empty space (1 of 1)',
    )
  })

  it('a drawn stroke is a drawing, counted among the ink', () => {
    const stroke = freehandLine(
      's',
      [
        { x: 0, y: 0 },
        { x: 20, y: 30 },
        { x: 40, y: 10 },
      ],
      1,
    ) as CanvasLine
    expect(selectionMessage({ ...board, lines: [stroke] }, [], 's')).toBe(
      'Selected: Drawing (1 of 1)',
    )
  })

  it('nothing selected says nothing', () => {
    expect(selectionMessage(board, [], null)).toBeUndefined()
  })
})

describe('frame membership', () => {
  const front = groupNode({ id: 'f', x: 0, y: 0, width: 300, height: 200, label: 'Frontend' })
  const back = groupNode({ id: 'k', x: 400, y: 0, width: 300, height: 200, label: 'Backend' })
  const web = textNode({ id: 'w', x: 20, y: 40, width: 100, height: 40, text: 'Web App' })
  const board: SpatialCanvas = { nodes: [front, back, web], edges: [] }
  const at = (x: number, y = 40): SpatialCanvas => ({
    ...board,
    nodes: [front, back, { ...web, x, y }],
  })

  it('a selected node says the frame it sits in', () => {
    expect(selectionMessage(board, ['w'], null)).toBe('Selected: Web App, in Frontend (3 of 3)')
  })

  it('a nudge that stays inside the frame says nothing', () => {
    expect(canvasChangeMessage(board, at(28))).toBeUndefined()
  })

  it('a move out of a frame says it left', () => {
    expect(canvasChangeMessage(board, at(20, 400))).toBe('Web App left Frontend')
  })

  it('a move into a frame says which', () => {
    expect(canvasChangeMessage(at(20, 400), at(420))).toBe('Web App moved into Backend')
  })

  it('a move from one frame to another names both', () => {
    expect(canvasChangeMessage(board, at(420))).toBe('Web App moved from Frontend into Backend')
  })

  it('a frame moved over a note at rest does not say the note moved', () => {
    const outside: SpatialCanvas = { ...board, nodes: [front, back, { ...web, y: 400 }] }
    const over: SpatialCanvas = {
      ...outside,
      nodes: [{ ...front, y: 380 }, back, { ...web, y: 400 }],
    }
    expect(canvasChangeMessage(outside, over)).toBeUndefined()
  })

  it('a frame carrying its notes changes no membership', () => {
    const moved: SpatialCanvas = {
      ...board,
      nodes: [{ ...front, x: 8 }, back, { ...web, x: 28 }],
    }
    expect(canvasChangeMessage(board, moved)).toBeUndefined()
  })
})

describe('what a tidy sounds like', () => {
  const front = groupNode({ id: 'f', x: 0, y: 0, width: 300, height: 300, label: 'Frontend' })
  const back = groupNode({ id: 'k', x: 400, y: 0, width: 300, height: 300, label: 'Backend' })
  const note = (id: string, x: number) =>
    textNode({ id, x, y: 40, width: 100, height: 40, text: id.toUpperCase() })
  const nodes = [front, back, note('p', 20), note('q', 150), note('r', 420), note('s', 900)]

  it('counts the notes it moved and the frames they sit in', () => {
    const moves = [
      { id: 'p', x: 24, y: 40 },
      { id: 'q', x: 150, y: 44 },
      { id: 'r', x: 424, y: 40 },
    ]
    expect(tidyMessage(nodes, moves)).toBe('Tidied 3 notes in 2 frames')
  })

  it('a note outside every frame is counted without a frame', () => {
    expect(tidyMessage(nodes, [{ id: 's', x: 904, y: 40 }])).toBe('Tidied 1 note')
  })

  it('a move that changes nothing is not a tidy', () => {
    expect(tidyMessage(nodes, [{ id: 'p', x: 20, y: 40 }])).toBe('Already tidy')
    expect(tidyMessage(nodes, [])).toBe('Already tidy')
  })
})
