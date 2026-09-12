// An edge with a FREE end — one that sits at a bare point rather than on a
// node ([ADR-0035](../../../../../docs/contributing/adr/0035-model-and-format.md)
// slice 3b).
//
// The model could store one from slice 3a and this renderer would not draw
// it: `routeEdge` read a BOX per end, a free end has none, and a missing box
// degraded to a zero-length path — the same answer a dangling reference gets,
// which is right for a reference that is broken and wrong for a point that is
// exactly where somebody put it.
//
// The whole change is that a point IS a box, a degenerate one. These tests
// are written against that consequence rather than against the helper: what a
// reader cares about is that the line reaches the point and stops there.

import type { CanvasLine, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { routeEdge } from './spatial-edges.js'

const box = (id: string, x: number, y: number): SpatialNode => ({
  id,
  type: 'text',
  text: id,
  x,
  y,
  width: 100,
  height: 60,
})

const last = <T>(items: readonly T[]): T => items[items.length - 1] as T

describe('a line that ends at a point', () => {
  it('draws a line that terminates exactly on the point', () => {
    const nodes = [box('a', 0, 0)]
    const edge: CanvasLine = {
      id: 'e',
      from: { kind: 'node', node: 'a' },
      to: { kind: 'point', point: { x: 400, y: 30 } },
    }
    const routed = routeEdge(nodes, edge)
    expect(routed.path.length).toBeGreaterThan(1)
    // The END of the line is the point the document names — not near it, and
    // not the origin the old degradation answered with.
    expect(last(routed.path)).toEqual({ x: 400, y: 30 })
  })

  it('leaves the node end on the node, so only one end is free', () => {
    const nodes = [box('a', 0, 0)]
    const routed = routeEdge(nodes, {
      id: 'e',
      from: { kind: 'node', node: 'a' },
      to: { kind: 'point', point: { x: 400, y: 30 } },
    })
    const [start] = routed.path
    // ON the border, not merely inside it — containment alone passed while
    // the whole route was still the degenerate [origin, origin], because the
    // origin is this box's own corner. An assertion a broken implementation
    // satisfies is the one worth catching before it is written down.
    const onBorder =
      ((start!.x === 0 || start!.x === 100) && start!.y >= 0 && start!.y <= 60) ||
      ((start!.y === 0 || start!.y === 60) && start!.x >= 0 && start!.x <= 100)
    expect(onBorder, `start ${JSON.stringify(start)} is not on the node's border`).toBe(true)
    // And the line goes somewhere, which is what the degenerate answer did not.
    expect(start).not.toEqual(last(routed.path))
  })

  it('draws an edge whose BOTH ends are free', () => {
    // Nothing in the model forbids it, so the renderer may not answer with a
    // dot. This is the shape a freehand stroke's first increment needs.
    const routed = routeEdge([], {
      id: 'e',
      from: { kind: 'point', point: { x: 10, y: 10 } },
      to: { kind: 'point', point: { x: 200, y: 120 } },
    })
    expect(routed.path[0]).toEqual({ x: 10, y: 10 })
    expect(last(routed.path)).toEqual({ x: 200, y: 120 })
  })

  it('still degrades a DANGLING reference, which is a different thing', () => {
    // A point is where somebody put it; a reference to a node that is not
    // there is broken. The first draws, the second must keep answering with
    // the documented zero-length path rather than inventing a location.
    const routed = routeEdge([box('a', 0, 0)], {
      id: 'e',
      from: { kind: 'node', node: 'a' },
      to: { node: 'ghost' },
    })
    expect(routed.path).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ])
  })

  it('honours stored bends between a node and a point', () => {
    // `bendRoute` takes the two boxes, so a free end reaching it as a
    // degenerate box is what makes an authored path work on one.
    const routed = routeEdge([box('a', 0, 0)], {
      id: 'e',
      from: { kind: 'node', node: 'a' },
      to: { kind: 'point', point: { x: 400, y: 300 } },
      bends: [{ x: 400, y: 30 }],
    })
    expect(routed.path).toContainEqual({ x: 400, y: 30 })
    expect(last(routed.path)).toEqual({ x: 400, y: 300 })
  })
})
