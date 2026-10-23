import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, it } from 'vitest'
import { anchorChipLabel } from './anchor-chip-label.js'

const canvas: SpatialCanvas = {
  nodes: [
    textNode({
      id: 'n1',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      text: '# Sign-up form\nwith a second line',
    }),
    textNode({ id: 'n2', x: 0, y: 0, width: 100, height: 50, text: 'x'.repeat(80) }),
  ],
  edges: [],
}

it('names a node by the first line of its text, without markdown heading marks', () => {
  expect(anchorChipLabel({ kind: 'spatial', nodeId: 'n1', x: 0, y: 0 }, canvas)).toBe(
    'on Sign-up form',
  )
})

it('shortens a long first line', () => {
  const label = anchorChipLabel({ kind: 'spatial', nodeId: 'n2', x: 0, y: 0 }, canvas)
  expect(label.length).toBeLessThanOrEqual('on '.length + 28)
  expect(label.endsWith('…')).toBe(true)
})

it('says a node when the node is gone or has no text to name it by', () => {
  expect(anchorChipLabel({ kind: 'spatial', nodeId: 'gone', x: 0, y: 0 }, canvas)).toBe('on a node')
})

it('says canvas for a spot, edge for a relation, and the whole document for no place', () => {
  expect(anchorChipLabel({ kind: 'spatial', x: 5, y: 5 }, canvas)).toBe('on canvas')
  expect(anchorChipLabel({ kind: 'spatial', edgeId: 'e1', x: 5, y: 5 }, canvas)).toBe('on an edge')
  expect(anchorChipLabel({ kind: 'document' }, null)).toBe('whole document')
})

it('says a paragraph for a passage of a note body and a node for a passage of a node', () => {
  expect(anchorChipLabel({ kind: 'text', quote: { exact: 'hi' }, start: 0, end: 2 }, null)).toBe(
    'on a paragraph',
  )
  expect(
    anchorChipLabel(
      { kind: 'text', nodeId: 'n1', quote: { exact: 'hi' }, start: 0, end: 2 },
      canvas,
    ),
  ).toBe('on Sign-up form')
})

const edgeCanvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'API Gateway' }),
    textNode({ id: 'b', x: 200, y: 0, width: 100, height: 50, text: 'Order Service' }),
    textNode({ id: 'c', x: 400, y: 0, width: 100, height: 50, text: '' }),
    groupNode({ id: 'g', x: 0, y: 200, width: 100, height: 50 }),
  ],
  edges: [
    {
      id: 'e1',
      from: { node: 'a', side: 'right', end: 'none' },
      to: { node: 'b', side: 'left', end: 'arrow' },
    },
    {
      id: 'e2',
      from: { node: 'c', side: 'right', end: 'none' },
      to: { node: 'g', side: 'top', end: 'arrow' },
    },
  ],
}

it('names an edge by the nodes it joins', () => {
  expect(anchorChipLabel({ kind: 'spatial', edgeId: 'e1', x: 5, y: 5 }, edgeCanvas)).toBe(
    'on API Gateway → Order Service',
  )
})

it('names an edge end that has no text by what kind of node it is', () => {
  expect(anchorChipLabel({ kind: 'spatial', edgeId: 'e2', x: 5, y: 5 }, edgeCanvas)).toBe(
    'on text node → group',
  )
})
