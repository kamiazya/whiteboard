// What the grid router costs one layout on a board built to defeat every
// cheaper route. `routeOnGrid` runs only after the enumerated candidates all
// fail, and the side-choice search re-routes each edge under every side pair
// it tries, so a board whose every edge falls through to the grid pays for
// the grid thousands of times in one layout. Each call is bounded in CELLS
// (`MAX_GRID_CELLS`) but not in the obstacles it buckets per grid line, and
// duplicate obstacles add no cell at all.
//
// Work, not wall time: every obstacle test the router makes reads a rect's
// coordinates, so wrapping each rect it is handed in counting getters measures
// its work exactly and independently of machine load.

import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { layoutSpatialEdges } from '../spatial-canvas.js'
import type { Rect } from './edge-geometry.js'

const grid = vi.hoisted(() => ({ calls: 0, reads: 0 }))

vi.mock('./grid-route.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./grid-route.js')>()
  const counted = (r: Rect): Rect => ({
    get x() {
      grid.reads++
      return r.x
    },
    get y() {
      grid.reads++
      return r.y
    },
    get w() {
      grid.reads++
      return r.w
    },
    get h() {
      grid.reads++
      return r.h
    },
  })
  return {
    ...actual,
    routeOnGrid: (...args: Parameters<typeof actual.routeOnGrid>) => {
      grid.calls++
      const [start, end, obstacles, ...rest] = args
      return actual.routeOnGrid(start, end, obstacles.map(counted), ...rest)
    },
  }
})

const box = (id: string, x: number, y: number, w: number, h: number): SpatialNode =>
  textNode({ id, x, y, width: w, height: h, text: '' })

/**
 * `edges` edges from A to B, where B sits in a closed cage and a curtain of
 * one-pixel walls, taller than the router's search reach, stands between
 * them. No elbow and no detour around one box can reach B, so every route
 * falls through to the grid; the walls give it hundreds of distinct grid
 * lines, and the copies of them fill the board to its node ceiling without
 * adding a single cell.
 */
function cagedBoard(walls: number, totalNodes: number, edges: number): SpatialCanvas {
  const nodes: SpatialNode[] = [
    box('A', 0, 0, 100, 100),
    box('B', 1000, 0, 100, 100),
    box('cage-left', 940, -60, 10, 220),
    box('cage-right', 1150, -60, 10, 220),
    box('cage-top', 940, -70, 220, 10),
    box('cage-bottom', 940, 160, 220, 10),
  ]
  for (let k = 0; k < walls; k++) nodes.push(box(`wall${k}`, 200 + k, -5000, 1, 10000))
  for (let k = 0; nodes.length < totalNodes; k++) {
    nodes.push(box(`copy${k}`, 200 + (k % walls), -5000, 1, 10000))
  }
  const routed: CanvasEdge[] = Array.from({ length: edges }, (_, i) => ({
    id: `e${i}`,
    from: { node: 'A' },
    to: { node: 'B' },
  }))
  return { nodes, edges: routed, facets: { 'visual.edges/v0': { routing: 'orthogonal' } } }
}

describe('grid routing cost per layout', () => {
  it('bounds the obstacle tests one layout spends on grid searches', () => {
    const board = cagedBoard(600, 2000, 30)
    grid.calls = 0
    grid.reads = 0
    const scene = layoutSpatialEdges(board, {
      measure: createFakeMeasure(),
      parseBody: () => ({ type: 'root', children: [] }),
      appearance: { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) },
    })

    // The subject is present: every edge is drawn, and the board drove the
    // grid search far more often than once per edge.
    expect(scene.filter((n) => n.kind === 'edge')).toHaveLength(30)
    expect(grid.calls).toBeGreaterThan(1000)
    // Unbounded, this board reads 3.9e9 coordinates over 1376 searches (90s
    // on a dev machine), 3.7e8 over 297 at a third of the edges: the work
    // tracks grid lines times obstacles, which the cell cap does not see,
    // and the search count grows faster than the edges. Bounded, 1.9e8.
    expect(grid.reads).toBeLessThanOrEqual(250_000_000)
  }, 300_000)
})
