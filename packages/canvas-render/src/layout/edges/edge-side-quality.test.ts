// Side-choice quality terms beyond crossings: a route must never RETRACE
// over its own ink (the doubled-line arrival a facing-away side produces
// on overlapping nodes), and among equal-crossing configurations the one
// with fewer REALIZED bends wins — the abstract pair ranking (L before Z)
// can lie once obstacles force the L into a staircase. Crossing-free,
// overlap-free documents are still never reshuffled: the optimizer's
// short-circuit ignores the bend term on purpose.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const box = (id: string, x: number, y: number, width: number, height: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  text: id,
})

function routed(nodes: SpatialNode[], edges: CanvasEdge[], id: string) {
  const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
  const edge = edges.find((e) => e.id === id) as CanvasEdge
  return {
    sides: anchors.get(id),
    path: routeEdge(nodes, edge, 'orthogonal', anchors.get(id)).path,
  }
}

/** Collinear overlap of a path with itself, adjacent retraces included. */
function selfOverlap(path: readonly { x: number; y: number }[]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    for (let j = i + 1; j < path.length; j++) {
      const a1 = path[i - 1] as { x: number; y: number }
      const a2 = path[i] as { x: number; y: number }
      const b1 = path[j - 1] as { x: number; y: number }
      const b2 = path[j] as { x: number; y: number }
      if (a1.x === a2.x && b1.x === b2.x && a1.x === b1.x) {
        const lo = Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y))
        const hi = Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y))
        if (hi > lo) total += hi - lo
      } else if (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y) {
        const lo = Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x))
        const hi = Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x))
        if (hi > lo) total += hi - lo
      }
    }
  }
  return total
}

function bends(path: readonly { x: number; y: number }[]): number {
  const dirs: string[] = []
  for (let i = 1; i < path.length; i++) {
    const dx = Math.sign((path[i] as { x: number }).x - (path[i - 1] as { x: number }).x)
    const dy = Math.sign((path[i] as { y: number }).y - (path[i - 1] as { y: number }).y)
    if (dx === 0 && dy === 0) continue
    const dir = `${dx},${dy}`
    if (dirs[dirs.length - 1] !== dir) dirs.push(dir)
  }
  return Math.max(0, dirs.length - 1)
}

describe('self-overlap (retrace) cost', () => {
  it('an edge between overlapping nodes never retraces over its own line', () => {
    // m2 overlaps m1's lower half. A facing-away arrival (top -> bottom)
    // overshoots through the body and doubles back by the stub length —
    // the visible twin-line arrival. A retrace-free pair must win instead.
    const nodes = [
      box('m1', 200, 200, 200, 160),
      box('m2', 240, 300, 200, 300),
      // A crossing pair elsewhere keeps the optimizer engaged (a fully
      // clean canvas short-circuits before any trial, by design).
      box('x1', 700, 100, 100, 60),
      box('x2', 900, 300, 100, 60),
      box('x3', 900, 100, 100, 60),
      box('x4', 700, 300, 100, 60),
    ]
    const edges: CanvasEdge[] = [
      { id: 'hair', fromNode: 'm2', toNode: 'm1' },
      { id: 'c1', fromNode: 'x1', toNode: 'x2' },
      { id: 'c2', fromNode: 'x3', toNode: 'x4' },
    ]
    const { path } = routed(nodes, edges, 'hair')
    expect(selfOverlap(path)).toBe(0)
  })
})

describe('realized-bend tie-break', () => {
  it('equal-crossing side pairs prefer the route with fewer real bends', () => {
    // The (right,top) L is forced into a 3-bend staircase by the wall;
    // the (top,top) hook over the top is 2 bends. Both cross the vertical
    // edge exactly once, so bends decide.
    const nodes = [
      box('src', 0, 400, 200, 100),
      box('dst', 700, 700, 200, 100),
      box('wall', 320, 380, 160, 200),
      box('up', 550, 0, 100, 60),
      box('down', 550, 900, 100, 60),
    ]
    const edges: CanvasEdge[] = [
      { id: 'main', fromNode: 'src', toNode: 'dst' },
      { id: 'vert', fromNode: 'up', toNode: 'down' },
    ]
    const { path } = routed(nodes, edges, 'main')
    expect(bends(path)).toBeLessThanOrEqual(2)
  })

  it('a crossing-free canvas is never reshuffled for bends alone', () => {
    // Same shape WITHOUT the crossing pair: the optimizer short-circuits
    // on the zero [overlap, illegible, crossings] prefix, so the staircase
    // stays — churn on healthy documents is worse than a extra bend.
    const nodes = [
      box('src', 0, 400, 200, 100),
      box('dst', 700, 700, 200, 100),
      box('wall', 320, 380, 160, 200),
    ]
    const edges: CanvasEdge[] = [{ id: 'main', fromNode: 'src', toNode: 'dst' }]
    const { sides } = routed(nodes, edges, 'main')
    expect(sides?.fromSide).toBe('right')
    expect(sides?.toSide).toBe('top')
  })
})
