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

  it('derives default sides deterministically when b is to the left of a', () => {
    const nodes = [node('a', 300, 0, 100, 100), node('b', 0, 0, 100, 100)]
    const result = routeEdge(nodes, edge({ id: 'e1', fromNode: 'a', toNode: 'b' }))
    expect(result.fromSide).toBe('left')
    expect(result.toSide).toBe('right')
  })

  it('derives default sides deterministically when b is above a', () => {
    const nodes = [node('a', 0, 300, 100, 100), node('b', 0, 0, 100, 100)]
    const result = routeEdge(nodes, edge({ id: 'e1', fromNode: 'a', toNode: 'b' }))
    expect(result.fromSide).toBe('top')
    expect(result.toSide).toBe('bottom')
  })

  it('produces a deterministic self-edge loop path without throwing', () => {
    const nodes = [node('a', 0, 0, 100, 100)]
    const result = routeEdge(nodes, edge({ id: 'e1', fromNode: 'a', toNode: 'a' }))
    expect(result.path.length).toBeGreaterThan(1)
    expect(result.fromSide).toBe('right')
    expect(result.toSide).toBe('right')
  })

  it('routes a self-edge loop outward along the right side when explicitly selected', () => {
    const nodes = [node('a', 0, 0, 100, 100)]
    const result = routeEdge(
      nodes,
      edge({ id: 'e1', fromNode: 'a', toNode: 'a', fromSide: 'right', toSide: 'right' }),
    )
    // The right side's outward normal is +x, so the loop control points must
    // sit strictly to the right of the node (x > 100).
    for (const point of result.path.slice(1, -1)) {
      expect(point.x).toBeGreaterThan(100)
    }
  })

  it('routes a self-edge loop outward along the left side when explicitly selected', () => {
    const nodes = [node('a', 0, 0, 100, 100)]
    const result = routeEdge(
      nodes,
      edge({ id: 'e1', fromNode: 'a', toNode: 'a', fromSide: 'left', toSide: 'left' }),
    )
    // The left side's outward normal is -x, so the loop control points must
    // sit strictly to the left of the node (x < 0).
    for (const point of result.path.slice(1, -1)) {
      expect(point.x).toBeLessThan(0)
    }
  })

  it('routes a self-edge loop outward along the top side when explicitly selected', () => {
    const nodes = [node('a', 0, 0, 100, 100)]
    const result = routeEdge(
      nodes,
      edge({ id: 'e1', fromNode: 'a', toNode: 'a', fromSide: 'top', toSide: 'top' }),
    )
    // The top side's outward normal is -y, so the loop control points must
    // sit strictly above the node (y < 0).
    for (const point of result.path.slice(1, -1)) {
      expect(point.y).toBeLessThan(0)
    }
  })

  it('routes a self-edge loop outward along the bottom side when explicitly selected', () => {
    const nodes = [node('a', 0, 0, 100, 100)]
    const result = routeEdge(
      nodes,
      edge({ id: 'e1', fromNode: 'a', toNode: 'a', fromSide: 'bottom', toSide: 'bottom' }),
    )
    // The bottom side's outward normal is +y, so the loop control points
    // must sit strictly below the node (y > 100).
    for (const point of result.path.slice(1, -1)) {
      expect(point.y).toBeGreaterThan(100)
    }
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
