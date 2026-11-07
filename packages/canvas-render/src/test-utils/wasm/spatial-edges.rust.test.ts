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
const style = fc.constantFrom<EdgeRoutingStyle>('straight', 'straight', 'straight', 'orthogonal', 'curved')
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

const drawn = (canvas: fc.Arbitrary<[SpatialNode[], RoutableElement[]]>) =>
  canvas.chain(([nodes, edges]) =>
    fc.record({
      nodes: fc.constant(nodes),
      edges: fc.constant(edges),
      styles: fc.tuple(...edges.map(() => style)),
      overrides: overridesFor(edges),
      labels: fc.array(rect, { maxLength: 2 }),
      trials: accountDraw(createRoutingBudget().trials),
      // A fraction of what the search spends with the account ample, so it
      // runs out partway through, after it has adopted something.
      cut: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined, freq: 5 }),
      pairs: accountDraw(createRoutingBudget().pairs),
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

const reach = { searched: 0, stepped: 0, overridden: 0, cutShort: 0, partway: 0, regions: 0 }

/** The trials an unconstrained search spends on `d`. */
function fullSpend(
  d: Drawn,
  styleOf: (e: RoutableElement) => EdgeRoutingStyle,
  overrides: ReadonlyMap<string, EdgeAnchorOverride> | undefined,
): number {
  const ample = { ...createRoutingBudget(), pairs: d.pairs }
  assignEdgeAnchors(d.nodes, d.edges, styleOf, overrides, ample, d.labels as readonly Rect[])
  return createRoutingBudget().trials - ample.trials
}

function check(d: Drawn) {
  const wire = encodeRouting(d.nodes, d.edges)
  const idOf = (id: string) => wire.edgeIds.indexOf(id)
  const overrides = overrideMap(d)
  const labels = d.labels as readonly Rect[]
  const styleByEdge = new Map(d.edges.map((e, i) => [e, d.styles[i] as EdgeRoutingStyle]))
  const fresh = createRoutingBudget()
  const styleOf = (e: RoutableElement) => styleByEdge.get(e) ?? 'straight'
  const trials =
    d.cut === undefined ? d.trials : Math.floor(fullSpend(d, styleOf, overrides) * d.cut)
  const budget: RoutingBudget = { ...fresh, trials, pairs: d.pairs }
  const ts = assignEdgeAnchors(d.nodes, d.edges, styleOf, overrides, budget, labels)
  const input = Float64Array.from([
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

  // Searched: some edge left on sides the first guess did not pick.
  const routed = d.edges.filter((e) => !marksContact(d.nodes, e))
  const initial = initialSideChoices(d.nodes, routed)
  const moved = [...ts].some(([id, e]) => {
    const first = initial.get(id)
    return first !== undefined && (first.fromSide !== e.fromSide || first.toSide !== e.toSide)
  })
  if (moved) reach.searched += 1
  if ([...ts.values()].some((e) => e.around === true)) reach.stepped += 1
  if (overrides !== undefined && overrides.size > 0) reach.overridden += 1
  if (budget.trials < fresh.trials / 2 || budget.pairs < fresh.pairs / 2) reach.cutShort += 1
  // Cut to part of what an ample run spends, and not to nothing.
  if (d.cut !== undefined && trials > 0) reach.partway += 1
  if (routed.length > 200) reach.regions += 1
}

describe.runIf(built)('assignEdgeAnchors and its Rust port settle the same anchors', () => {
  fcTest.prop([fc.oneof(drawn(scene), drawn(board(9, 14)), drawn(board(9, 14)))], withDefaults())(
    'anchors and the budget left, over small canvases',
    check,
  )

  // Past the 200-edge gate the search runs over Morton-ordered regions.
  fcTest.prop([drawn(board(24, 230, 210))], withDefaults({ numRuns: 5 }))(
    'anchors and the budget left, over regions',
    check,
  )

  afterAllFloor(
    [
      'anchors and the budget left, over small canvases',
      'anchors and the budget left, over regions',
    ],
    () => {
      // About half the lowest of five measured runs (searched 122, stepped
      // 67, overridden 84, cutShort 124; regions is every region run).
      const floors = { searched: 61, stepped: 33, overridden: 42, cutShort: 62, regions: 5 }
      for (const [kind, floor] of Object.entries(floors)) {
        expect(reach[kind as keyof typeof reach], kind).toBeGreaterThanOrEqual(floor)
      }
    },
  )
})
