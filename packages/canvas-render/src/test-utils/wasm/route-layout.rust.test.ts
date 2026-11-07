import type { EdgeRoutingStyle, EdgeSide } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
import type { Rect } from '../../layout/edges/edge-geometry.js'
import { routeEdge } from '../../layout/edges/edge-router.js'
import { createRoutingBudget, type RoutingBudget } from '../../layout/edges/routing-budget.js'
import { assignEdgeAnchors } from '../../layout/edges/spatial-edges.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { firstDifference } from './edge-arbitraries.js'
import { built, requireWasm } from './glue.js'
import { scene } from './routing-arbitraries.js'
import { encodeRouting } from './routing-wire.js'
import { board, type Drawn, drawn, overrideMap, SIDES, wireInput } from './search-arbitraries.js'

/**
 * One layout's edge routing in one wasm call (`edge_route_layout`) against
 * what canvas-render's composer does between `assignEdgeAnchors` and its
 * per-edge `routeEdge` (ADR-0054 step 5, QR-22b): every edge's path,
 * rounding, sides and ends in input order, and every budget account left,
 * the grid account included, since the search and the routing after it
 * draw on one budget.
 */

const end = (e: string | undefined) => (e === 'arrow' ? 1 : 0)
const routedValues = (r: ResolvedEdgeNode) => [
  r.rounded === true ? 1 : 0,
  SIDES.indexOf(r.fromSide as EdgeSide),
  SIDES.indexOf(r.toSide as EdgeSide),
  end(r.fromEnd),
  end(r.toEnd),
  r.path.length,
  ...r.path.flatMap((p) => [p.x, p.y]),
]

/** The grid account: ample mostly, sometimes short enough to run out partway through the edges. */
const gridDraw = fc.oneof(
  { weight: 1, arbitrary: fc.constant(createRoutingBudget().grid) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 5_000 }) },
)

const reach = { bent: 0, unanchored: 0, gridSpent: 0, overridden: 0 }

function check([d, grid]: [Drawn, number]) {
  const wire = encodeRouting(d.nodes, d.edges)
  const overrides = overrideMap(d)
  const labels = d.labels as readonly Rect[]
  const styleByEdge = new Map(d.edges.map((e, i) => [e, d.styles[i] as EdgeRoutingStyle]))
  const styleOf = (e: RoutableElement) => styleByEdge.get(e) ?? 'straight'
  const budget: RoutingBudget = { ...createRoutingBudget(), grid, trials: d.trials, pairs: d.pairs }
  const anchors = assignEdgeAnchors(d.nodes, d.edges, styleOf, overrides, budget, labels)
  const routed = d.edges.map((edge) =>
    routeEdge(d.nodes, edge, styleOf(edge), anchors.get(edge.id), undefined, budget, labels),
  )
  const out = requireWasm().edge_route_layout(wireInput(d, wire, overrides, d.trials, grid))
  const expected = [
    budget.grid,
    budget.pairs,
    budget.trials,
    budget.repairs,
    routed.length,
    ...routed.flatMap(routedValues),
  ]
  expect(firstDifference(expected, out)).toBeUndefined()

  if (routed.some((r) => r.path.length > 2)) reach.bent += 1
  if (d.edges.some((e) => anchors.get(e.id) === undefined)) reach.unanchored += 1
  // A short grid account the routing drew on: whether the search and the
  // routing after it share one budget is judged only on these.
  if (grid < createRoutingBudget().grid && budget.grid < grid) reach.gridSpent += 1
  if (overrides !== undefined && overrides.size > 0) reach.overridden += 1
}

describe.runIf(built)('one layout routed in one call matches the composer', () => {
  fcTest.prop(
    [fc.tuple(fc.oneof(drawn(scene), drawn(board(9, 14)), drawn(board(9, 14))), gridDraw)],
    withDefaults(),
  )('every route and the budget left', check)

  afterAllFloor(['every route and the budget left'], () => {
    // About half the lowest of eight measured runs (bent 178, gridSpent 8,
    // overridden 74, unanchored 37).
    const floors = { bent: 89, gridSpent: 4, overridden: 37, unanchored: 18 }
    for (const [kind, floor] of Object.entries(floors)) {
      expect(reach[kind as keyof typeof reach], kind).toBeGreaterThanOrEqual(floor)
    }
  })
})
