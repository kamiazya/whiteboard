import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { routeEdge } from './spatial-edges.js'

function node(id: string, x: number, y: number, width: number, height: number): SpatialNode {
  return { type: 'text', id, x, y, width, height, text: '' }
}

function edge(
  overrides: Partial<CanvasEdge> & Pick<CanvasEdge, 'id' | 'fromNode' | 'toNode'>,
): CanvasEdge {
  return overrides
}

describe('routeEdge', () => {
  it('honors explicit fromSide/toSide', () => {
    const nodes = [node('a', 0, 0, 100, 100), node('b', 200, 0, 100, 100)]
    const result = routeEdge(
      nodes,
      edge({ id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left' }),
    )
    expect(result.fromSide).toBe('right')
    expect(result.toSide).toBe('left')
    expect(result.path[0]).toEqual({ x: 100, y: 50 })
    expect(result.path.at(-1)).toEqual({ x: 200, y: 50 })
  })

  it('derives default sides deterministically when neither side is given (b is to the right of a)', () => {
    const nodes = [node('a', 0, 0, 100, 100), node('b', 300, 0, 100, 100)]
    const result = routeEdge(nodes, edge({ id: 'e1', fromNode: 'a', toNode: 'b' }))
    expect(result.fromSide).toBe('right')
    expect(result.toSide).toBe('left')
  })

  it('derives default sides deterministically when b is below a', () => {
    const nodes = [node('a', 0, 0, 100, 100), node('b', 0, 300, 100, 100)]
    const result = routeEdge(nodes, edge({ id: 'e1', fromNode: 'a', toNode: 'b' }))
    expect(result.fromSide).toBe('bottom')
    expect(result.toSide).toBe('top')
  })

  it('produces a deterministic self-edge loop path without throwing', () => {
    const nodes = [node('a', 0, 0, 100, 100)]
    const result = routeEdge(nodes, edge({ id: 'e1', fromNode: 'a', toNode: 'a' }))
    expect(result.path.length).toBeGreaterThan(1)
    expect(result.fromSide).toBe('right')
    expect(result.toSide).toBe('right')
  })

  it('handles coincident/zero-sized nodes deterministically without throwing', () => {
    const nodes = [node('a', 10, 10, 0, 0), node('b', 10, 10, 0, 0)]
    const result = routeEdge(nodes, edge({ id: 'e1', fromNode: 'a', toNode: 'b' }))
    expect(result.path).toHaveLength(2)
    expect(Number.isFinite(result.path[0].x)).toBe(true)
  })

  it('falls back to a degenerate zero-length path for a missing endpoint instead of throwing', () => {
    const nodes = [node('a', 0, 0, 100, 100)]
    const result = routeEdge(nodes, edge({ id: 'e1', fromNode: 'a', toNode: 'missing' }))
    expect(result.path).toHaveLength(2)
    expect(result.path[0]).toEqual(result.path[1])
  })

  it('is a pure function: same input yields the same output', () => {
    const nodes = [node('a', 0, 0, 100, 100), node('b', 300, 0, 100, 100)]
    const e = edge({ id: 'e1', fromNode: 'a', toNode: 'b' })
    expect(routeEdge(nodes, e)).toEqual(routeEdge(nodes, e))
  })
})
