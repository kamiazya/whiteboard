import type { EdgeRoutingStyle, EdgeSide } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import { createRoutingBudget, type EdgeAnchorPair, type RoutingBudget } from '../../edge-routing.js'
import type { Rect } from '../../generated/geometry.zod.js'
import type { RoutingCore } from '../../layout-core.js'
import { fc } from '../fast-check.js'
import {
  latticeLayouts,
  ROUTING_CORPUS,
  type RoutingCase,
  stackedFrameLayouts,
  syntheticLayouts,
} from '../routing-corpus.js'
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
 * The recorded corpus of `edge_route_layout`'s answers (ADR-0054 step 5,
 * QR-17), and the draws it was recorded from.
 *
 * The recording was taken from the TypeScript composer's routing while it
 * existed, and is frozen since its deletion (step 7, S18h3b; D13: every
 * recording is kept and still read by a test). Two replays read it:
 * `crates/bindings/wasm/tests/recorded_oracle.rs` holds the export equal to
 * it natively, bit for bit, so cargo-mutants judges the edge crate's mutants
 * by it; `recorded-oracle.test.ts` regenerates the same draws, routes them
 * through `@kamiazya/whiteboard-core-wasm`'s typed call, the one a root hands
 * canvas-render, and holds both the wire it encodes and the answer it decodes
 * to the recording.
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

/** One layout: the wire `edge_route_layout` reads and what the core answers to it. */
export interface RouteLayoutCase {
  readonly input: Float64Array
  readonly expected: readonly number[]
  readonly routed: readonly ResolvedEdgeNode[]
  readonly anchors: ReadonlyMap<string, EdgeAnchorPair>
  readonly budget: RoutingBudget
}

/**
 * The edge routing of `d` with `grid` in the grid account, asked of `core`
 * (the side search, then every edge's route on the same budget), laid out as
 * `edge_route_layout` answers it.
 */
export function routeLayoutCase(core: RoutingCore, d: Drawn, grid: number): RouteLayoutCase {
  const wire = encodeRouting(d.nodes, d.edges)
  const overrides = overrideMap(d)
  const labels = d.labels as readonly Rect[]
  const styleByEdge = new Map(d.edges.map((e, i) => [e, d.styles[i] as EdgeRoutingStyle]))
  const styleOf = (e: RoutableElement) => styleByEdge.get(e) ?? 'straight'
  const budget: RoutingBudget = { ...createRoutingBudget(), grid, trials: d.trials, pairs: d.pairs }
  const { routes: routed, anchors } = core.routeLayout(
    d.nodes,
    d.edges,
    styleOf,
    overrides,
    budget,
    labels,
  )
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
  const input = wireInput(d, wire, overrides, d.trials, grid)
  return { input, expected, routed, anchors, budget }
}

const STYLE_NAMES: readonly EdgeRoutingStyle[] = ['straight', 'orthogonal', 'curved']

/** A corpus board as a draw: one style for every edge, no overrides, every account ample. */
function corpusDraw(c: RoutingCase, style: EdgeRoutingStyle): Drawn {
  const fresh = createRoutingBudget()
  return {
    nodes: [...c.nodes],
    edges: [...c.edges] as RoutableElement[],
    styles: c.edges.map(() => style),
    overrides: undefined,
    labels: [],
    trials: fresh.trials,
    cut: undefined,
    pairs: fresh.pairs,
  } as unknown as Drawn
}

/**
 * The seed the generated half of the corpus is sampled from. This is a
 * FIXTURE's seed, not a property's: the recording has to be the same set of
 * boards every time it is regenerated, or the committed file could never
 * equal it. The properties that explore keep drawing fresh seeds.
 */
const CORPUS_SEED = 20_261_108

/** How many generated draws of each kind the corpus holds. */
const GENERATED = { scene: 60, board: 60, orthogonal: 30 } as const

/** The grid accounts a generated draw is recorded under, in turn: ample, or cut. */
const GRIDS = [createRoutingBudget().grid, 0, 60, 400] as const

/** Every recorded layout, in a fixed order. */
export function recordedDraws(): readonly { readonly draw: Drawn; readonly grid: number }[] {
  const full = createRoutingBudget().grid
  const corpus = [
    ...ROUTING_CORPUS,
    ...syntheticLayouts(30),
    ...latticeLayouts(12),
    ...stackedFrameLayouts(6),
  ].flatMap((c) => STYLE_NAMES.map((s) => ({ draw: corpusDraw(c, s), grid: full })))
  const sample = (arb: fc.Arbitrary<Drawn>, n: number, offset: number) =>
    fc
      .sample(arb, { seed: CORPUS_SEED + offset, numRuns: n })
      .map((draw, i) => ({ draw, grid: GRIDS[i % GRIDS.length] as number }))
  const generated = [
    ...sample(drawn(scene), GENERATED.scene, 0),
    ...sample(drawn(board(9, 14)), GENERATED.board, 1),
    ...sample(
      drawn(board(9, 14), { style: fc.constant('orthogonal' as const) }),
      GENERATED.orthogonal,
      2,
    ),
  ]
  return [...corpus, ...generated]
}

/** The recording's file: `[count, then per case: input length, input, answer length, answer]` as little-endian f64. */
export function encodeRecording(cases: readonly RouteLayoutCase[]): Uint8Array {
  // Written number by number: spreading a case into one call's arguments
  // would meet the engine's argument limit long before the wire cap.
  const total = 1 + cases.reduce((n, c) => n + 2 + c.input.length + c.expected.length, 0)
  const bytes = new Uint8Array(total * 8)
  const view = new DataView(bytes.buffer)
  let at = 0
  const put = (v: number) => {
    view.setFloat64(at, v, true)
    at += 8
  }
  put(cases.length)
  for (const c of cases) {
    put(c.input.length)
    for (const v of c.input) put(v)
    put(c.expected.length)
    for (const v of c.expected) put(v)
  }
  return bytes
}
