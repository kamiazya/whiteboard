import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { EdgeRoutingStyle, EdgeSide } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
import { marksContact } from '../../layout/edges/edge-contact.js'
import type { Rect } from '../../layout/edges/edge-geometry.js'
import { routeEdge } from '../../layout/edges/edge-router.js'
import { createRoutingBudget, type RoutingBudget } from '../../layout/edges/routing-budget.js'
import { assignEdgeAnchors } from '../../layout/edges/spatial-edges.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { firstDifference } from './edge-arbitraries.js'
import { built, requireWasm, wasmBytes } from './glue.js'
import { scene } from './routing-arbitraries.js'
import { encodeRouting } from './routing-wire.js'
import {
  board,
  type Drawn,
  drawn,
  entryValues,
  overrideMap,
  SIDES,
  wireInput,
} from './search-arbitraries.js'

/**
 * One layout's edge routing in one wasm call (`edge_route_layout`) against
 * what canvas-render's composer does between `assignEdgeAnchors` and its
 * per-edge `routeEdge` (ADR-0054 step 5, QR-22b): every edge's path,
 * rounding, sides and ends in input order, the anchors the search settled
 * (the composer hands them on), and every budget account left,
 * the grid account included, since the search and the routing after it
 * draw on one budget. In this project `./edge-router.js` and
 * `./grid-route.js` resolve to the Rust ports inside the TypeScript modules,
 * so the reference routes through Rust too: what this holds is the
 * orchestration around them (the order, the shared budget, the labels, the
 * edges the search leaves out), and the router and the grid search keep
 * their own differentials.
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

/**
 * The grid account: ample, a fixed cut that may run out anywhere, or just
 * past what the search itself spends, so the routing AFTER the search is
 * the pass that runs it dry. A fixed cut alone reached that last case too
 * rarely to judge it on every run.
 */
type GridDraw =
  | { readonly kind: 'full' }
  | { readonly kind: 'cut'; readonly grid: number }
  | { readonly kind: 'pastSearch'; readonly slack: number }
const gridDraw: fc.Arbitrary<GridDraw> = fc.oneof(
  fc.constant({ kind: 'full' as const }),
  fc.record({ kind: fc.constant('cut' as const), grid: fc.integer({ min: 0, max: 5_000 }) }),
  fc.record({ kind: fc.constant('pastSearch' as const), slack: fc.integer({ min: 0, max: 400 }) }),
)

const reach = { bent: 0, contact: 0, gridSpent: 0, overridden: 0 }

let loaded: ReturnType<typeof coreFrom> | undefined
const core = () => {
  loaded ??= coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  return loaded
}

function check([d, draw]: [Drawn, GridDraw]) {
  const wire = encodeRouting(d.nodes, d.edges)
  const overrides = overrideMap(d)
  const labels = d.labels as readonly Rect[]
  const styleByEdge = new Map(d.edges.map((e, i) => [e, d.styles[i] as EdgeRoutingStyle]))
  const styleOf = (e: RoutableElement) => styleByEdge.get(e) ?? 'straight'
  const grid = gridOf(draw, d, styleOf, overrides, labels)
  const budget: RoutingBudget = { ...createRoutingBudget(), grid, trials: d.trials, pairs: d.pairs }
  const anchors = assignEdgeAnchors(d.nodes, d.edges, styleOf, overrides, budget, labels)
  const afterSearch = budget.grid
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
    anchors.size,
    ...[...anchors].flatMap(([id, e]) => entryValues(wire.edgeIds.indexOf(id), e)),
  ]
  expect(firstDifference(expected, out)).toBeUndefined()

  // The same layout through @kamiazya/whiteboard-core-wasm's typed call, the
  // one a composition root will hand canvas-render: its encoder and decoder
  // are judged here, against the same TypeScript composition.
  const shimBudget: RoutingBudget = {
    ...createRoutingBudget(),
    grid,
    trials: d.trials,
    pairs: d.pairs,
  }
  const shim = core().routeLayout(d.nodes, d.edges, styleOf, overrides, shimBudget, labels)
  expect(shim.routes).toEqual(routed)
  expect([...shim.anchors]).toEqual([...anchors])
  expect(shimBudget).toEqual(budget)

  if (routed.some((r) => r.path.length > 2)) reach.bent += 1
  // An edge the search leaves out, which the composer still routes.
  if (d.edges.some((e) => marksContact(d.nodes, e))) reach.contact += 1
  // A short grid account the ROUTING drew on after the search: whether the
  // two share one budget is judged only on these.
  if (grid < createRoutingBudget().grid && budget.grid < afterSearch) reach.gridSpent += 1
  if (overrides !== undefined && overrides.size > 0) reach.overridden += 1
}

/** The grid account a draw names; `pastSearch` measures the search's own spend first. */
function gridOf(
  draw: GridDraw,
  d: Drawn,
  styleOf: (e: RoutableElement) => EdgeRoutingStyle,
  overrides: ReturnType<typeof overrideMap>,
  labels: readonly Rect[],
): number {
  const full = createRoutingBudget().grid
  if (draw.kind === 'full') return full
  if (draw.kind === 'cut') return draw.grid
  const probe: RoutingBudget = { ...createRoutingBudget(), trials: d.trials, pairs: d.pairs }
  assignEdgeAnchors(d.nodes, d.edges, styleOf, overrides, probe, labels)
  return full - probe.grid + draw.slack
}

describe.runIf(built)('one layout routed in one call matches the composer', () => {
  fcTest.prop(
    [
      fc.tuple(
        fc.oneof(
          drawn(scene),
          drawn(board(9, 14)),
          // Every edge orthogonal on a crowded board: the routing after the
          // search searches the grid, which is what spends that account.
          drawn(board(9, 14), { style: fc.constant('orthogonal' as const) }),
        ),
        gridDraw,
      ),
    ],
    withDefaults(),
  )('every route and the budget left', check)

  afterAllFloor(['every route and the budget left'], () => {
    // About half the lowest of five measured runs (bent 185, contact 10,
    // gridSpent 4, overridden 79). gridSpent is a cut account the routing
    // drew on AFTER the search: the `pastSearch` draws and the orthogonal
    // boards are what reach it; before them a run could reach it never.
    const floors = { bent: 92, gridSpent: 2, overridden: 40, contact: 5 }
    for (const [kind, floor] of Object.entries(floors)) {
      expect(reach[kind as keyof typeof reach], kind).toBeGreaterThanOrEqual(floor)
    }
  })
})
