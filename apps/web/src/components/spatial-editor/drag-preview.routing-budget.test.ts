// @vitest-environment node

// The connect preview routes on every pointer move, outside any layout, so
// it has to open the routing account a layout would. Without one, a board
// that drives every route to the grid search runs it unbounded per frame.

import { createRoutingBudget, type LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import { requireLayoutCore } from '../../lib/spatial/require-layout-core.js'
import { computeDragPreview } from './drag-preview.js'

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

type Budget = ReturnType<typeof createRoutingBudget>

/** This realm's core, recording the account each routing call is handed and what it leaves. */
function recordingCore(): { core: LayoutCore; asked: Budget[]; left: Budget[] } {
  const realm = requireLayoutCore()
  const asked: Budget[] = []
  const left: Budget[] = []
  const core = fakeLayoutCore({
    routing: {
      routeLayout(nodes, edges, styleOf, overrides, budget, labels) {
        asked.push(budget)
        const routed = realm.routing.routeLayout(nodes, edges, styleOf, overrides, budget, labels)
        left.push({ ...budget })
        return routed
      },
    },
  })
  return { core, asked, left }
}

function previewOnto(canvas: SpatialCanvas, core: LayoutCore) {
  const selectableBoxes: NodeBox[] = canvas.nodes.map((n) => ({
    id: n.id,
    box: { x: n.x, y: n.y, width: n.width, height: n.height },
  }))
  return computeDragPreview(
    { kind: 'connecting', fromNodeId: 'A' },
    selectableBoxes,
    { x: 1050, y: 50 },
    { canvas, selectableBoxes, core },
  )
}

describe('computeDragPreview — routing budget', () => {
  it('routes the connect preview from one budget it charges', () => {
    const { core, asked, left } = recordingCore()
    expect(previewOnto(cagedBoard(), core)?.kind).toBe('line')

    expect(asked).toHaveLength(1)
    // The caged target sends the route to the grid, which spends from it.
    expect(left[0]?.grid).toBeLessThan(createRoutingBudget().grid)
  })

  it('opens a fresh budget for each pointer move', () => {
    const { core, asked } = recordingCore()
    previewOnto(cagedBoard(), core)
    previewOnto(cagedBoard(), core)
    const [first, second] = asked
    expect(first).toBeDefined()
    expect(second).not.toBe(first)
  })
})
