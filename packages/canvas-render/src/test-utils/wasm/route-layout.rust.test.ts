import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { EdgeRoutingStyle } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
import { marksContact } from '../../layout/edges/edge-contact.js'
import type { Rect } from '../../layout/edges/edge-geometry.js'
import { createRoutingBudget, type RoutingBudget } from '../../layout/edges/routing-budget.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { firstDifference } from './edge-arbitraries.js'
import { built, requireWasm, wasmBytes } from './glue.js'
import { routeLayoutCase } from './route-layout-oracle.js'
import { scene } from './routing-arbitraries.js'
import { board, type Drawn, drawn, overrideMap } from './search-arbitraries.js'

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

/**
 * The grid account: ample, a fixed cut that may run out anywhere, or just
 * past what the search itself spends, so the routing AFTER the search is
 * the pass that runs it dry. A fixed cut alone reached that last case too
 * rarely to judge it on every run.
 *
 * `pastSearch` leaves a SHARE of what the routing after the search spends
 * with the account ample, not a fixed slack: a grid call the account cannot
 * cover is refused before it spends anything, and the routing's spend runs
 * from under a hundred tests to several thousand, so a fixed slack was
 * refused outright on most boards that reached it. The share is a percentage
 * from half up: measured over boards whose routing reaches the grid, a tenth
 * of its spend let it draw on 2 of 105, half on 38, nine tenths on 93 — and
 * all of it on every one, where nothing is left to run dry.
 */
type GridDraw =
  | { readonly kind: 'full' }
  | { readonly kind: 'cut'; readonly grid: number }
  | { readonly kind: 'pastSearch'; readonly percent: number }
const pastSearch: fc.Arbitrary<GridDraw> = fc.record({
  kind: fc.constant('pastSearch' as const),
  percent: fc.integer({ min: 50, max: 100 }),
})
const gridDraw = (pastSearchWeight: number): fc.Arbitrary<GridDraw> =>
  fc.oneof(
    { weight: 1, arbitrary: fc.constant({ kind: 'full' as const }) },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('cut' as const),
        grid: fc.integer({ min: 0, max: 5_000 }),
      }),
    },
    { weight: pastSearchWeight, arbitrary: pastSearch },
  )

const reach = { bent: 0, contact: 0, gridSpent: 0, overridden: 0 }

let loaded: ReturnType<typeof coreFrom> | undefined
const core = () => {
  loaded ??= coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  return loaded
}

function check([d, draw]: [Drawn, GridDraw]) {
  const overrides = overrideMap(d)
  const labels = d.labels as readonly Rect[]
  const styleByEdge = new Map(d.edges.map((e, i) => [e, d.styles[i] as EdgeRoutingStyle]))
  const styleOf = (e: RoutableElement) => styleByEdge.get(e) ?? 'straight'
  const grid = gridOf(draw, d)
  const { input, expected, routed, anchors, budget, afterSearch } = routeLayoutCase(d, grid)
  const out = requireWasm().edge_route_layout(input)
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

/**
 * The grid account a draw names; `pastSearch` measures, with the account
 * ample, what the search spends and what the routing after it spends.
 */
function gridOf(draw: GridDraw, d: Drawn): number {
  const full = createRoutingBudget().grid
  if (draw.kind === 'full') return full
  if (draw.kind === 'cut') return draw.grid
  const ample = routeLayoutCase(d, full)
  const routing = ample.afterSearch - ample.budget.grid
  return full - ample.afterSearch + Math.floor((draw.percent * routing) / 100)
}

describe.runIf(built)('one layout routed in one call matches the composer', () => {
  fcTest.prop(
    [
      fc.oneof(
        fc.tuple(drawn(scene), gridDraw(1)),
        fc.tuple(drawn(board(9, 14)), gridDraw(1)),
        // Every edge orthogonal on a board of six edges or more: the routing
        // after the search searches the grid, which is what spends that
        // account. It reaches the grid on about a third of these boards
        // even so, so this arm draws `pastSearch` three times in five.
        fc.tuple(
          drawn(board(9, 14, 6), { style: fc.constant('orthogonal' as const) }),
          gridDraw(3),
        ),
      ),
    ],
    withDefaults(),
  )('every route and the budget left', check)

  afterAllFloor(['every route and the budget left'], () => {
    // About half the lowest of 80 measured fresh-process runs (bent
    // 173, contact 10, gridSpent 5, overridden 75; medians 188, 18, 15, 90).
    // gridSpent is a cut account the routing drew on AFTER the search: the
    // `pastSearch` share and the orthogonal arm's weight on it reach it.
    // With a fixed slack of up to 400 tests drawn on a ninth of the mix its
    // median was 6, and this floor failed on CI at 1 and at 0.
    const floors = { bent: 92, gridSpent: 2, overridden: 40, contact: 5 }
    for (const [kind, floor] of Object.entries(floors)) {
      expect(reach[kind as keyof typeof reach], kind).toBeGreaterThanOrEqual(floor)
    }
  })
})
