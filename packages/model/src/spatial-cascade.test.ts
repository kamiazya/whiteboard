import { describe, expect, it } from 'vitest'
import { type CanvasLine, type SpatialCanvas, spatialCanvasSchema } from './spatial.js'
import { withoutNodes } from './spatial-cascade.js'
import { textNode } from './test-utils/index.js'

const A = textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'A' })
const B = textNode({ id: 'b', x: 50, y: 0, width: 10, height: 10, text: 'B' })
const C = textNode({ id: 'c', x: 100, y: 0, width: 10, height: 10, text: 'C' })

const anchoredOnA: CanvasLine = {
  id: 'ink-a',
  from: { kind: 'node', node: 'a' },
  to: { kind: 'point', point: { x: 30, y: 30 } },
}
const anchoredOnB: CanvasLine = {
  id: 'ink-b',
  from: { kind: 'point', point: { x: 30, y: 30 } },
  to: { kind: 'node', node: 'b' },
}
const free: CanvasLine = {
  id: 'ink-free',
  from: { kind: 'point', point: { x: 1, y: 1 } },
  to: { kind: 'point', point: { x: 2, y: 2 } },
}

const BOARD: SpatialCanvas = {
  nodes: [A, B, C],
  edges: [
    { id: 'ab', from: { node: 'a' }, to: { node: 'b' } },
    { id: 'bc', from: { node: 'b' }, to: { node: 'c' } },
  ],
  lines: [anchoredOnA, anchoredOnB, free],
}

describe('withoutNodes', () => {
  it('takes the edges and the ink anchored on a removed node, and leaves the rest', () => {
    const next = withoutNodes(BOARD, new Set(['a']))
    expect(next.nodes.map((node) => node.id)).toEqual(['b', 'c'])
    expect(next.edges.map((edge) => edge.id)).toEqual(['bc'])
    expect(next.lines).toEqual([anchoredOnB, free])
    expect(spatialCanvasSchema.safeParse(next).success).toBe(true)
  })

  it('sweeps across several ids at once', () => {
    const next = withoutNodes(BOARD, new Set(['a', 'b']))
    expect(next.nodes.map((node) => node.id)).toEqual(['c'])
    expect(next.edges).toEqual([])
    expect(next.lines).toEqual([free])
  })

  it('omits `lines` when the sweep empties it, as the model canonicalises', () => {
    const next = withoutNodes({ ...BOARD, lines: [anchoredOnA] }, new Set(['a']))
    expect('lines' in next).toBe(false)
  })

  it('leaves a canvas with no lines field without one', () => {
    const next = withoutNodes({ nodes: [A, B], edges: [] }, new Set(['a']))
    expect(next).toEqual({ nodes: [B], edges: [] })
  })

  it('changes nothing for an id that is not on the canvas', () => {
    expect(withoutNodes(BOARD, new Set(['missing']))).toEqual(BOARD)
  })
})
