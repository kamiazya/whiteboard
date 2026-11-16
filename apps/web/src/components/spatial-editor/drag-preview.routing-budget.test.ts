// @vitest-environment node

// The connect preview routes on every pointer move, outside any layout, so
// it has to open the routing account a layout would. Without one, a board
// that drives every route to the grid search runs it unbounded per frame.

import * as render from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import { computeDragPreview } from './drag-preview.js'

vi.mock('@kamiazya/whiteboard-canvas-render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kamiazya/whiteboard-canvas-render')>()
  return {
    ...actual,
    routeEdge: vi.fn(actual.routeEdge),
    assignEdgeAnchors: vi.fn(actual.assignEdgeAnchors),
  }
})

const box = (id: string, x: number, y: number, w: number, h: number): SpatialNode =>
  textNode({ id, x, y, width: w, height: h, text: '' })

/** B in a closed cage behind a curtain of walls: no elbow reaches it, so the route falls to the grid. */
function cagedBoard(): SpatialCanvas {
  const nodes: SpatialNode[] = [
    box('A', 0, 0, 100, 100),
    box('B', 1000, 0, 100, 100),
    box('cage-left', 940, -60, 10, 220),
    box('cage-right', 1150, -60, 10, 220),
    box('cage-top', 940, -70, 220, 10),
    box('cage-bottom', 940, 160, 220, 10),
  ]
  for (let k = 0; k < 20; k++) nodes.push(box(`wall${k}`, 200 + k * 5, -5000, 1, 10000))
  return { nodes, edges: [], facets: { 'visual.edges/v0': { routing: 'orthogonal' } } }
}

function previewOnto(canvas: SpatialCanvas) {
  const selectableBoxes: NodeBox[] = canvas.nodes.map((n) => ({
    id: n.id,
    box: { x: n.x, y: n.y, width: n.width, height: n.height },
  }))
  return computeDragPreview(
    { kind: 'connecting', fromNodeId: 'A' },
    selectableBoxes,
    { x: 1050, y: 50 },
    { canvas, selectableBoxes },
  )
}

const routeEdge = vi.mocked(render.routeEdge)
const assignEdgeAnchors = vi.mocked(render.assignEdgeAnchors)

describe('computeDragPreview — routing budget', () => {
  beforeEach(() => {
    routeEdge.mockClear()
    assignEdgeAnchors.mockClear()
  })

  it('routes the connect preview from one budget it charges', () => {
    expect(previewOnto(cagedBoard())?.kind).toBe('line')

    expect(routeEdge).toHaveBeenCalledTimes(1)
    const budget = routeEdge.mock.calls[0]?.[5]
    expect(budget).toBeDefined()
    expect(assignEdgeAnchors.mock.calls[0]?.[4]).toBe(budget)
    // The caged target sends the route to the grid, which spends from it.
    expect(budget?.grid).toBeLessThan(render.createRoutingBudget().grid)
  })

  it('opens a fresh budget for each pointer move', () => {
    previewOnto(cagedBoard())
    previewOnto(cagedBoard())
    const [first, second] = routeEdge.mock.calls.map((call) => call[5])
    expect(first).toBeDefined()
    expect(second).not.toBe(first)
  })
})
