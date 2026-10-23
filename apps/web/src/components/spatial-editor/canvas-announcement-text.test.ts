import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { canvasChangeMessage, selectionMessage } from './canvas-announcement-text.js'

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

  it('a frame that arrives around existing nodes is a grouping', () => {
    const frame = groupNode({ id: 'g', x: -10, y: -10, width: 340, height: 80 })
    expect(canvasChangeMessage(two, { nodes: [frame, a, b], edges: [] })).toBe('Grouped 2 nodes')
  })

  it('a new edge says which two it joins', () => {
    const edge = { id: 'e', from: { node: 'a' }, to: { node: 'b' } } as const
    expect(canvasChangeMessage(two, { nodes: [a, b], edges: [edge] })).toBe('Connected A to B')
  })

  it('a move, a resize or an edit is silent', () => {
    expect(canvasChangeMessage(two, { nodes: [{ ...a, x: 5 }, b], edges: [] })).toBeUndefined()
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

  it('an edge is named by what it joins', () => {
    const edge = { id: 'e', from: { node: 'a' }, to: { node: 'b' }, label: 'yes' } as const
    expect(selectionMessage({ ...board, edges: [edge] }, [], 'e')).toBe(
      'Selected: Edge from A to B: yes',
    )
  })

  it('nothing selected says nothing', () => {
    expect(selectionMessage(board, [], null)).toBeUndefined()
  })
})
