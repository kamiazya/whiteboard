import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { spatialCanvasSchema } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands.js'

function baseCanvas(): SpatialCanvas {
  return {
    nodes: [
      { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
      { id: 'b', type: 'file', x: 200, y: 0, width: 80, height: 40, file: 'x.png' },
    ],
    edges: [],
  }
}

describe('applyCommand', () => {
  it('move-node changes only that node x/y, leaving everything else reference-equal', () => {
    const canvas = baseCanvas()
    const snapshot = structuredClone(canvas)
    const next = applyCommand(canvas, { kind: 'move-node', id: 'a', x: 10, y: 20 })

    expect(next).not.toBe(canvas)
    expect(next.nodes[0]).toEqual({ ...canvas.nodes[0], x: 10, y: 20 })
    expect(next.nodes[1]).toBe(canvas.nodes[1])
    expect(next.edges).toBe(canvas.edges)
    expect(canvas).toEqual(snapshot) // input untouched
  })

  it('resize-node keeps the opposite anchor fixed and clamps to non-negative integers', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, {
      kind: 'resize-node',
      id: 'a',
      x: 0,
      y: 0,
      width: -5.7,
      height: 30.4,
    })
    const node = next.nodes[0]
    expect(node).toMatchObject({ x: 0, y: 0, width: 0, height: 30 })
  })

  it('set-text changes only the text field of a text node', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'set-text', id: 'a', text: 'updated' })
    expect(next.nodes[0]).toEqual({ ...canvas.nodes[0], text: 'updated' })
  })

  it('set-text on a non-text node is a no-op returning the input canvas', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'set-text', id: 'b', text: 'nope' })
    expect(next).toBe(canvas)
  })

  it('connect-nodes appends exactly one edge and leaves nodes untouched', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'b',
    })
    expect(next.nodes).toBe(canvas.nodes)
    expect(next.edges).toEqual([{ id: 'e1', fromNode: 'a', toNode: 'b' }])
  })

  it('connect-nodes rejects a missing endpoint as a no-op', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'missing',
    })
    expect(next).toBe(canvas)
  })

  it('connect-nodes rejects self-connection as a no-op', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'a',
    })
    expect(next).toBe(canvas)
  })

  it('is total: a command targeting a missing id returns the input unchanged', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'move-node', id: 'missing', x: 1, y: 1 })
    expect(next).toBe(canvas)
  })

  it('every produced canvas stays schema-valid', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'move-node', id: 'a', x: 5, y: 5 })
    expect(spatialCanvasSchema.safeParse(next).success).toBe(true)
  })
})
