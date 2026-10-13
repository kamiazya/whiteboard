import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { bendInkCommand, endInkCommand, labelInkCommand } from './ink-commands.js'

// With one element per collection, "this element" and "every element"
// answer alike — so every lookup here is asked for the SECOND of two.
const canvas: SpatialCanvas = {
  nodes: [],
  edges: [
    { id: 'e1', from: { node: 'a' }, to: { node: 'b' } },
    { id: 'e2', from: { node: 'b' }, to: { node: 'a' } },
  ],
  lines: [
    {
      id: 'l1',
      from: { kind: 'node', node: 'a' },
      to: { kind: 'point', point: { x: 400, y: 400 } },
    },
    { id: 'l2', from: { kind: 'node', node: 'b' }, to: { kind: 'point', point: { x: 9, y: 9 } } },
  ],
}

describe('the ink-id lookups, among several of a kind', () => {
  it('picks the bend write for the second edge and the second line', () => {
    const bends = [{ x: 1, y: 2 }]
    expect(bendInkCommand(canvas, 'e2', bends)).toEqual({ kind: 'set-edge-bends', id: 'e2', bends })
    expect(bendInkCommand(canvas, 'l2', bends)).toEqual({ kind: 'set-line-bends', id: 'l2', bends })
  })

  it('picks the label write for the second edge and the second line', () => {
    expect(labelInkCommand(canvas, 'e2', 'x')).toEqual({
      kind: 'set-edge-label',
      id: 'e2',
      label: 'x',
    })
    expect(labelInkCommand(canvas, 'l2', 'x')).toEqual({
      kind: 'set-line-label',
      id: 'l2',
      label: 'x',
    })
  })

  it('picks the end write for the second edge and the second line', () => {
    const onA = { kind: 'node', node: 'a' } as const
    expect(endInkCommand(canvas, 'e2', 'to', onA)).toEqual({
      kind: 'set-edge-end',
      id: 'e2',
      endpoint: 'to',
      node: 'a',
    })
    expect(endInkCommand(canvas, 'l2', 'to', onA)).toEqual({
      kind: 'set-line-end',
      id: 'l2',
      endpoint: 'to',
      target: onA,
    })
  })
})
