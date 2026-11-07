import { type EdgeRoutingStyle, edgeSideSchema, type SpatialNode } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
import { marksContact } from '../../layout/edges/edge-contact.js'
import type { Rect } from '../../layout/edges/edge-geometry.js'
import type { EdgeAnchorOverride, EdgeAnchorPair } from '../../layout/edges/edge-sides.js'
import { initialSideChoices } from '../../layout/edges/edge-sides.js'
import { createRoutingBudget, type RoutingBudget } from '../../layout/edges/routing-budget.js'
import { assignEdgeAnchors } from '../../layout/edges/spatial-edges.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { firstDifference, rect } from './edge-arbitraries.js'
import { built, requireWasm } from './glue.js'
import { scene } from './routing-arbitraries.js'
import { encodeRouting } from './routing-wire.js'

/**
 * `assignEdgeAnchors` (spatial-edges.ts) against its Rust port through the
 * wasm artifact (ADR-0054 step 5, QR-21 layer 2): the side-choice search,
 * its two runs, the regions past the edge gate, the frozen overrides and
 * the coincident-ends repair after, compared on every anchor and on what is
 * left of each budget account. In this project `./edge-router.js` is the
 * Rust router on both sides, so what this holds is the search around it.
 */

const SIDES = edgeSideSchema.options
const sideIndex = (s: string | undefined) => (s === undefined ? -1 : SIDES.indexOf(s as never))
const STYLES: Record<EdgeRoutingStyle, number> = { straight: 0, orthogonal: 1, curved: 2 }
// Straight mostly: only a straight edge steps round what is in its way.
const style = fc.constantFrom<EdgeRoutingStyle>(
  'straight',
  'straight',
  'straight',
  'orthogonal',
  'curved',
)
const side = fc.constantFrom(...SIDES)

/**
 * Boxes on a jittered grid with edges drawn between them at random, so
 * routes cross and overlap and the search has something to repair.
 */
const board = (maxBoxes: number, maxEdges: number, minEdges = 1) =>
  fc
    .tuple(
      fc.integer({ min: 2, max: 4 }),
      fc.array(fc.tuple(fc.integer({ min: -30, max: 30 }), fc.integer({ min: -30, max: 30 })), {
        minLength: 3,
        maxLength: maxBoxes,
      }),
    )
    .chain(([columns, jitter]) => {
      const nodes = jitter.map(
        ([dx, dy], i) =>
          ({
            id: `n${i}`,
            type: 'text',
            text: '',
            x: (i % columns) * 180 + dx,
            y: Math.floor(i / columns) * 140 + dy,
            width: 80,
            height: 50,
          }) as SpatialNode,
      )
      const end = fc.record(
        {
          node: fc.constantFrom(...nodes.map((n) => n.id)),
          side: fc.option(side, { freq: 4, nil: undefined }),
        },
        { requiredKeys: ['node'] },
      )
      const edge = fc
        .tuple(fc.integer({ min: 0, max: maxEdges * 2 }), end, end)
        .map(([id, from, to]) => ({ id: `b${id}`, from, to }) as RoutableElement)
      return fc.tuple(
        fc.constant(nodes),
        fc.array(edge, { minLength: minEdges, maxLength: maxEdges }),
      )
    })

const flaggedPoint = (p: { x: number; y: number } | undefined) =>
  p === undefined ? [0, 0, 0] : [1, p.x, p.y]
const flagged = (v: number | undefined) => (v === undefined ? [0, 0] : [1, v])

function entryValues(id: number, e: EdgeAnchorPair): number[] {
  return [
    id,
    ...flaggedPoint(e.from),
    ...flaggedPoint(e.to),
    ...flagged(e.fromLaneDepth),
    ...flagged(e.toLaneDepth),
    sideIndex(e.fromSide),
    sideIndex(e.toSide),
    e.around === true ? 1 : 0,
  ]
}

/** Overrides for some edges: sides, sometimes stepping round, sometimes pinned. */
const overridesFor = (edges: readonly RoutableElement[]) =>
  fc.option(
    fc.tuple(
      ...edges.map(() =>
        fc.option(
          fc.record({
            fromSide: side,
            toSide: side,
            around: fc.boolean(),
            from: fc.option(
              fc.record({
                x: fc.integer({ min: -50, max: 600 }),
                y: fc.integer({ min: -50, max: 400 }),
              }),
              {
                nil: undefined,
                freq: 3,
              },
            ),
          }),
          { nil: undefined, freq: 2 },
        ),
      ),
    ),
    { nil: undefined, freq: 2 },
  )

/** The trials and pairs accounts: ample mostly, sometimes cut short. */
const accountDraw = (ample: number) =>
  fc.oneof(
    { weight: 3, arbitrary: fc.constant(ample) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 400 }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 20_000 }) },
  )

/** How a draw varies what is around the canvas; each defaults to the broad mix. */
interface Around {
  readonly cut?: fc.Arbitrary<number | undefined>
  readonly style?: fc.Arbitrary<EdgeRoutingStyle>
  /** `false`: no overrides, and both accounts ample. */
  readonly frozen?: boolean
}

const drawn = (canvas: fc.Arbitrary<[SpatialNode[], RoutableElement[]]>, around: Around = {}) =>
  canvas.chain(([nodes, edges]) =>
    fc.record({
      nodes: fc.constant(nodes),
      edges: fc.constant(edges),
      styles: fc.tuple(...edges.map(() => around.style ?? style)),
      overrides: around.frozen === false ? fc.constant(undefined) : overridesFor(edges),
      labels: fc.array(rect, { maxLength: 2 }),
      trials:
        around.frozen === false
          ? fc.constant(createRoutingBudget().trials)
          : accountDraw(createRoutingBudget().trials),
      // A fraction of what the search spends with the account ample, so it
      // runs out partway through, after it has adopted something.
      cut:
        around.cut ??
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined, freq: 5 }),
      pairs:
        around.frozen === false
          ? fc.constant(createRoutingBudget().pairs)
          : accountDraw(createRoutingBudget().pairs),
    }),
  )

type Drawn = typeof drawn extends (...args: never[]) => fc.Arbitrary<infer T> ? T : never

function overrideMap(d: Drawn): Map<string, EdgeAnchorOverride> | undefined {
  if (d.overrides === undefined) return undefined
  const map = new Map<string, EdgeAnchorOverride>()
  d.edges.forEach((edge, i) => {
    const o = d.overrides?.[i]
    if (o === undefined) return
    map.set(edge.id, {
      fromSide: o.fromSide,
      toSide: o.toSide,
      ...(o.around ? { around: true as const } : {}),
      ...(o.from === undefined ? {} : { from: o.from }),
    })
  })
  return map
}

const reach = {
  searched: 0,
  stepped: 0,
  overridden: 0,
  pairsShort: 0,
  cutMattered: 0,
  fullGate: 0,
  regionGate: 0,
  regions: 0,
}

/** The trials an unconstrained search spends on `d`. */
function fullSpend(
  d: Drawn,
  styleOf: (e: RoutableElement) => EdgeRoutingStyle,
  overrides: ReadonlyMap<string, EdgeAnchorOverride> | undefined,
): { spent: number; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  const ample = { ...createRoutingBudget(), pairs: d.pairs }
  const anchors = assignEdgeAnchors(
    d.nodes,
    d.edges,
    styleOf,
    overrides,
    ample,
    d.labels as readonly Rect[],
  )
  return { spent: createRoutingBudget().trials - ample.trials, anchors }
}

/** The input `edge_assign_anchors` reads for `d`, with `trials` in the account. */
function wireInput(
  d: Drawn,
  wire: ReturnType<typeof encodeRouting>,
  overrides: ReadonlyMap<string, EdgeAnchorOverride> | undefined,
  trials: number,
): Float64Array {
  const idOf = (id: string) => wire.edgeIds.indexOf(id)
  const labels = d.labels as readonly Rect[]
  const fresh = createRoutingBudget()
  return Float64Array.from([
    ...wire.values,
    ...d.styles.map((s) => STYLES[s as EdgeRoutingStyle]),
    overrides === undefined ? 0 : 1,
    ...(overrides === undefined
      ? []
      : [
          overrides.size,
          ...[...overrides].flatMap(([id, p]) => [
            idOf(id),
            sideIndex(p.fromSide),
            sideIndex(p.toSide),
            p.around === true ? 1 : 0,
            ...flaggedPoint(p.from),
            ...flagged(p.fromLaneDepth),
            ...flaggedPoint(p.to),
            ...flagged(p.toLaneDepth),
          ]),
        ]),
    labels.length,
    ...labels.flatMap((r) => [r.x, r.y, r.w, r.h]),
    fresh.grid,
    d.pairs,
    trials,
    fresh.repairs,
  ])
}

const sameEntries = (
  a: ReadonlyMap<string, EdgeAnchorPair>,
  b: ReadonlyMap<string, EdgeAnchorPair>,
) => JSON.stringify([...a]) === JSON.stringify([...b])

/**
 * What the search did, counted for the floors from its own output: an
 * override re-sides an edge and carries `around` without any search, so
 * those draws do not count as searched or stepped.
 */
function tally(
  d: Drawn,
  ts: ReadonlyMap<string, EdgeAnchorPair>,
  overrides: ReadonlyMap<string, EdgeAnchorOverride> | undefined,
  budget: RoutingBudget,
  ample: ReadonlyMap<string, EdgeAnchorPair> | undefined,
): void {
  const routed = d.edges.filter((e) => !marksContact(d.nodes, e))
  const free = overrides === undefined || overrides.size === 0
  if (!free) reach.overridden += 1
  if (free) {
    // An edge the search left on sides the first guess did not pick.
    const initial = initialSideChoices(d.nodes, routed)
    const moved = [...ts].some(([id, e]) => {
      const first = initial.get(id)
      return first !== undefined && (first.fromSide !== e.fromSide || first.toSide !== e.toSide)
    })
    if (moved) reach.searched += 1
    if (moved && routed.length > 200) reach.regions += 1
    if ([...ts.values()].some((e) => e.around === true)) reach.stepped += 1
  }
  if (budget.pairs < createRoutingBudget().pairs / 2) reach.pairsShort += 1
  // The account ran out before the search was done: the cut changed the answer.
  if (ample !== undefined && !sameEntries(ample, ts)) reach.cutMattered += 1
  if (routed.length >= 38 && routed.length <= 42) reach.fullGate += 1
  if (routed.length >= 199 && routed.length <= 201) reach.regionGate += 1
}

function check(d: Drawn) {
  const wire = encodeRouting(d.nodes, d.edges)
  const idOf = (id: string) => wire.edgeIds.indexOf(id)
  const overrides = overrideMap(d)
  const labels = d.labels as readonly Rect[]
  const styleByEdge = new Map(d.edges.map((e, i) => [e, d.styles[i] as EdgeRoutingStyle]))
  const fresh = createRoutingBudget()
  const styleOf = (e: RoutableElement) => styleByEdge.get(e) ?? 'straight'
  const full = d.cut === undefined ? undefined : fullSpend(d, styleOf, overrides)
  const trials = full === undefined ? d.trials : Math.floor(full.spent * (d.cut as number))
  const budget: RoutingBudget = { ...fresh, trials, pairs: d.pairs }
  const ts = assignEdgeAnchors(d.nodes, d.edges, styleOf, overrides, budget, labels)
  const input = wireInput(d, wire, overrides, trials)
  const out = requireWasm().edge_assign_anchors(input)
  const expected = [
    budget.grid,
    budget.pairs,
    budget.trials,
    budget.repairs,
    ts.size,
    ...[...ts].flatMap(([id, e]) => entryValues(idOf(id), e)),
  ]
  expect(firstDifference(expected, out)).toBeUndefined()

  tally(d, ts, overrides, budget, full?.anchors)
}

/**
 * The ceiling for a property over boards of 40 or 200 edges, each run laid
 * out twice (TypeScript and Rust): measured locally at up to 17s for the
 * regions property, and a CI runner is slower.
 */
const HEAVY_MS = 120_000

describe.runIf(built)('assignEdgeAnchors and its Rust port settle the same anchors', () => {
  fcTest.prop([fc.oneof(drawn(scene), drawn(board(9, 14)), drawn(board(9, 14)))], withDefaults())(
    'anchors and the budget left, over small canvases',
    check,
  )

  // Run out partway through on a crowded board, where the search has
  // adopted something: an around it adopted must survive the account
  // running out, which only this draw reaches often enough.
  fcTest.prop(
    [
      drawn(board(9, 20), {
        cut: fc.double({ min: 0.05, max: 1, noNaN: true }),
        style: fc.constant('straight'),
        frozen: false,
      }),
    ],
    withDefaults(),
  )('anchors and the budget left, over an account cut short', check)

  // Either side of the full-search size (40) and of the edge gate (200).
  fcTest.prop(
    [fc.oneof(drawn(board(16, 42, 38)), drawn(board(16, 42, 38), { frozen: false }))],
    withDefaults({ numRuns: 30 }),
  )('anchors and the budget left, around the full-search size', check, HEAVY_MS)
  fcTest.prop(
    [drawn(board(24, 201, 199), { cut: fc.constant(undefined) })],
    withDefaults({ numRuns: 4 }),
  )('anchors and the budget left, around the edge gate', check, HEAVY_MS)

  // Past the 200-edge gate the search runs over Morton-ordered regions, with
  // the account ample so every region is searched.
  fcTest.prop(
    [drawn(board(24, 230, 210), { cut: fc.constant(undefined), frozen: false })],
    withDefaults({ numRuns: 3 }),
  )('anchors and the budget left, over regions', check, HEAVY_MS)

  afterAllFloor(
    [
      'anchors and the budget left, over small canvases',
      'anchors and the budget left, over regions',
    ],
    () => {
      // About half the lowest of five measured runs (searched 153, stepped
      // 33, overridden 98, pairsShort 89, cutMattered 208, regions 5). The
      // gate draws are presence counts: every run of those lands there.
      const floors = {
        searched: 76,
        stepped: 16,
        overridden: 49,
        pairsShort: 44,
        cutMattered: 104,
        fullGate: 15,
        regionGate: 2,
        regions: 2,
      }
      for (const [kind, floor] of Object.entries(floors)) {
        expect(reach[kind as keyof typeof reach], kind).toBeGreaterThanOrEqual(floor)
      }
    },
  )
})
