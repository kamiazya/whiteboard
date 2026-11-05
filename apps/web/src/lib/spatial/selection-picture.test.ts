import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { selectionPicture } from './selection-picture.js'

const edge = (id: string, from: string, to: string) => ({
  id,
  from: { node: from },
  to: { node: to },
})

const board: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'frame', x: 0, y: 0, width: 400, height: 300, label: 'Actions' }),
    textNode({ id: 'in1', x: 20, y: 40, width: 120, height: 60, text: 'Inside' }),
    textNode({ id: 'in2', x: 200, y: 40, width: 120, height: 60, text: 'Also inside' }),
    textNode({ id: 'out', x: 600, y: 40, width: 120, height: 60, text: 'Elsewhere' }),
  ],
  edges: [edge('inner', 'in1', 'in2'), edge('leaving', 'in2', 'out')],
  lines: [
    {
      id: 'ink-in',
      from: { kind: 'point', point: { x: 10, y: 10 } },
      to: { kind: 'node', node: 'in1' },
    },
    {
      id: 'ink-out',
      from: { kind: 'point', point: { x: 900, y: 900 } },
      to: { kind: 'node', node: 'in1' },
    },
  ],
  comments: [
    { id: 'on-in1', x: 30, y: 50, text: 'Who owns this?', targetNodeId: 'in1' },
    { id: 'on-out', x: 610, y: 50, text: 'Later', targetNodeId: 'out' },
    { id: 'spot-in', x: 300, y: 200, text: 'Here' },
    { id: 'spot-out', x: 800, y: 800, text: 'There' },
  ],
}

const thread = (id: string, anchor: CommentThread['anchor']): CommentThread => ({
  id,
  anchor,
  status: 'open',
  messages: [{ id: `${id}-m`, body: 'x' }],
})

describe('selectionPicture', () => {
  it('draws a selected frame with its members and the edges both of whose ends it holds', () => {
    const { canvas } = selectionPicture(board, [], ['frame'])
    expect(canvas.nodes.map((node) => node.id)).toEqual(['frame', 'in1', 'in2'])
    expect(canvas.edges.map((e) => e.id)).toEqual(['inner'])
  })

  it('keeps an edge between two nodes selected separately', () => {
    const { canvas } = selectionPicture(board, [], ['in2', 'out'])
    expect(canvas.nodes.map((node) => node.id)).toEqual(['in2', 'out'])
    expect(canvas.edges.map((e) => e.id)).toEqual(['leaving'])
  })

  it('keeps the ink and the comments that belong to the selection, and nothing else', () => {
    const { canvas } = selectionPicture(board, [], ['frame'])
    expect((canvas.lines ?? []).map((line) => line.id)).toEqual(['ink-in'])
    expect((canvas.comments ?? []).map((comment) => comment.id)).toEqual(['on-in1', 'spot-in'])
  })

  it('keeps the conversations anchored inside the selection', () => {
    const threads = [
      thread('t-node', { kind: 'spatial', nodeId: 'in1', x: 0, y: 0 }),
      thread('t-away', { kind: 'spatial', nodeId: 'out', x: 0, y: 0 }),
      thread('t-passage', {
        kind: 'text',
        nodeId: 'in2',
        quote: { exact: 'Also' },
        start: 0,
        end: 4,
      }),
      thread('t-doc', { kind: 'document' }),
    ]
    const kept = selectionPicture(board, threads, ['frame']).threads.map((t) => t.id)
    expect(kept).toEqual(['t-node', 't-passage'])
  })

  it('answers the whole board when the selection names nothing on it', () => {
    const { canvas } = selectionPicture(board, [], ['gone'])
    expect(canvas).toBe(board)
  })
})
