import {
  type EdgeSide,
  edgeSideSchema,
  endSide,
  isSelfLoop,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
import { type BendRouteEnds, bendRoute } from '../../layout/edges/bend-route.js'
import { contactRoute, marksContact } from '../../layout/edges/edge-contact.js'
import {
  centerOf,
  type Point,
  rectAtEnd,
  rectOf,
  sidePoint,
} from '../../layout/edges/edge-geometry.js'
import {
  deriveDefaultSides,
  initialSideChoices,
  rankedSidePairs,
  selfEdgeLoopControlPoints,
} from '../../layout/edges/edge-sides.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { coordinate, firstDifference, point, rect } from './edge-arbitraries.js'
import { built, requireWasm } from './glue.js'
import { encodeRouting } from './routing-wire.js'

/**
 * The router's end-handling leaves against their Rust port through the
 * wasm artifact (ADR-0054 step 5, QR-21 layer 2): edge-sides.ts's first side
 * choice, edge-contact.ts and bend-route.ts, over whole canvases sent as the
 * routing wire the layout's one call will cross. Each side computes its own
 * answer from the same draw, compared exactly.
 */

const SIDES = edgeSideSchema.options
const sideIndex = (side: EdgeSide | undefined) => (side === undefined ? -1 : SIDES.indexOf(side))
const side = fc.constantFrom(...SIDES)

/**
 * A canvas small enough to collide: node ids drawn from a short pool so one
 * id can name two nodes, a second box sometimes placed against the first
 * so the contact rule fires, and edge ids drawn from a short pool too.
 */
const canvas = fc
  .tuple(
    fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c', 'd', 'e'), rect), {
      minLength: 1,
      maxLength: 6,
    }),
    fc.option(fc.tuple(fc.constantFrom('right', 'below'), coordinate), { freq: 2 }),
    fc.option(fc.constantFrom(...edgeSideSchema.options), { freq: 2 }),
  )
  .map(([drawn, touching, occluded]) => {
    const nodes = drawn.map(
      ([id, r]) =>
        ({ id, type: 'text', text: '', x: r.x, y: r.y, width: r.w, height: r.h }) as SpatialNode,
    )
    const first = nodes[0] as SpatialNode
    if (touching !== null) {
      const [where, offset] = touching
      const along = Number.isFinite(offset) ? offset % 30 : 0
      nodes.push({
        ...first,
        id: 'touching',
        x: where === 'right' ? first.x + first.width : first.x + along,
        y: where === 'right' ? first.y + along : first.y + first.height,
      } as SpatialNode)
    }
    if (occluded !== null) {
      // A bystander over the midpoint of one of the first box's sides, so
      // the default side choice has to move off it.
      const p = sidePoint(rectOf(first), occluded)
      nodes.push({
        ...first,
        id: 'occluder',
        x: p.x - 10,
        y: p.y - 10,
        width: 20,
        height: 20,
      } as SpatialNode)
    }
    return nodes
  })

const arrowhead = fc.option(fc.constantFrom('none' as const, 'arrow' as const), { nil: undefined })
/**
 * Bends anywhere, sometimes not finite, and sometimes at a node's CENTRE,
 * where the nearest-border search meets an exact tie between two sides.
 */
function bendsOver(nodes: readonly SpatialNode[]) {
  const centre = fc
    .constantFrom(...nodes)
    .map((n) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 }))
  return fc.option(
    fc.array(
      fc.oneof(
        { weight: 5, arbitrary: point },
        { weight: 2, arbitrary: centre },
        { weight: 1, arbitrary: fc.constant({ x: Number.NaN, y: 0 }) },
      ),
      { minLength: 1, maxLength: 3 },
    ),
    { nil: undefined, freq: 3 },
  )
}

/**
 * Edges over a canvas, their ends naming its own nodes mostly (and a missing
 * one sometimes), and, when the canvas has a box placed against its first,
 * an unbent edge between the two so the contact rule has something to mark.
 */
function elementsOver(nodes: readonly SpatialNode[]): fc.Arbitrary<RoutableElement[]> {
  const ids = nodes.map((n) => n.id)
  const nodeRef = fc.oneof(
    { weight: 8, arbitrary: fc.constantFrom(...ids) },
    { weight: 1, arbitrary: fc.constant('missing') },
  )
  const edgeEnd = fc.record(
    { node: nodeRef, side: fc.option(side, { nil: undefined, freq: 3 }), end: arrowhead },
    { requiredKeys: ['node'] },
  )
  const lineEnd = fc.oneof(
    { weight: 3, arbitrary: edgeEnd.map((e) => ({ kind: 'node' as const, ...e })) },
    {
      weight: 1,
      arbitrary: fc.record(
        { kind: fc.constant('point' as const), point, end: arrowhead },
        { requiredKeys: ['kind', 'point'] },
      ),
    },
  )
  const element = fc
    .tuple(
      fc.constantFrom('e1', 'e2', 'e3', 'e4', 'e5', 'e6'),
      fc.boolean(),
      edgeEnd,
      edgeEnd,
      lineEnd,
      lineEnd,
      bendsOver(nodes),
    )
    .map(
      ([id, isLine, ef, et, lf, lt, b]) =>
        (isLine
          ? { id, from: lf, to: lt, bends: b }
          : { id, from: ef, to: et, bends: b }) as RoutableElement,
    )
  const touching = ids.includes('touching')
  const contact = fc
    .tuple(fc.constantFrom('c1', 'c2'), fc.boolean())
    .map(([id, reversed]): RoutableElement => {
      const [a, b] = reversed ? ['touching', ids[0] as string] : [ids[0] as string, 'touching']
      return { id, from: { node: a }, to: { node: b } } as RoutableElement
    })
  return fc
    .tuple(
      fc.array(element, { maxLength: 8 }),
      touching ? fc.array(contact, { maxLength: 2 }) : fc.constant([]),
    )
    .map(([es, cs]) => [...es, ...cs])
}

const scene = canvas.chain((nodes) => fc.tuple(fc.constant(nodes), elementsOver(nodes)))

const anchorOrNot = fc.option(point, { nil: undefined })
const bendEnds = fc.record(
  {
    from: anchorOrNot,
    to: anchorOrNot,
    fromSide: fc.option(side, { nil: undefined }),
    toSide: fc.option(side, { nil: undefined }),
  },
  { requiredKeys: [] },
)

const routeOut = (route: readonly Point[] | undefined) =>
  route === undefined ? [-1] : [route.length, ...route.flatMap((p) => [p.x, p.y])]

const reach = {
  choices: 0,
  namedFromKept: 0,
  namedToKept: 0,
  partnerMoved: 0,
  contacts: 0,
  marked: 0,
  bent: 0,
  refusedBends: 0,
  missingRect: 0,
}

const unnamed = (end: RoutableElement['from']) => {
  const { side: _side, ...rest } = end as { side?: EdgeSide }
  return rest as RoutableElement['from']
}

/**
 * Reach only: a named side kept where the derived one would differ (each
 * end), and the departure moved off an occluded side, which re-derives the
 * arrival from the facing axis. Read with the exported functions, not the
 * answer compared.
 */
function countNamedAndMoved(
  nodes: readonly SpatialNode[],
  edges: readonly RoutableElement[],
  choices: ReadonlyMap<string, { fromSide: EdgeSide; toSide: EdgeSide }>,
): void {
  const stripped = edges.map(
    (e) => ({ ...e, from: unnamed(e.from), to: unnamed(e.to) }) as RoutableElement,
  )
  const derived = initialSideChoices(nodes, stripped)
  for (const e of edges) {
    const chosen = choices.get(e.id)
    const free = derived.get(e.id)
    if (chosen === undefined || free === undefined) continue
    if (endSide(e.from) !== undefined && chosen.fromSide !== free.fromSide) reach.namedFromKept += 1
    if (endSide(e.to) !== undefined && chosen.toSide !== free.toSide) reach.namedToKept += 1
    const from = rectAtEnd(nodes, e.from)
    const to = rectAtEnd(nodes, e.to)
    if (from === undefined || to === undefined || isSelfLoop(e)) continue
    const [fc0, tc0] = [centerOf(from), centerOf(to)]
    const ranked = rankedSidePairs(tc0.x - fc0.x, tc0.y - fc0.y, from, to, () => 0)
    if (deriveDefaultSides(nodes, e, from, to).fromSide !== ranked[0]?.fromSide)
      reach.partnerMoved += 1
  }
}

describe.runIf(built)(
  'edge-sides.ts, edge-contact.ts, bend-route.ts and their Rust port answer the same',
  () => {
    fcTest.prop([scene], withDefaults())('initial side choices', ([nodes, edges]) => {
      const wire = encodeRouting(nodes, edges)
      const choices = initialSideChoices(nodes, edges)
      const ts = [choices.size]
      for (const [id, pair] of choices) {
        ts.push(wire.edgeIds.indexOf(id), sideIndex(pair.fromSide), sideIndex(pair.toSide))
      }
      reach.choices += choices.size
      countNamedAndMoved(nodes, edges, choices)
      expect(
        firstDifference(ts, requireWasm().edge_initial_sides(Float64Array.from(wire.values))),
      ).toBeUndefined()
    })

    fcTest.prop([scene], withDefaults())('contacts', ([nodes, edges]) => {
      const ts = edges.flatMap((edge) => {
        const from = rectAtEnd(nodes, edge.from)
        const to = rectAtEnd(nodes, edge.to)
        const contact =
          from !== undefined && to !== undefined
            ? contactRoute(edge, from, to, 'none', 'arrow')
            : undefined
        const marks = marksContact(nodes, edge)
        if (contact !== undefined) reach.contacts += 1
        if (marks) reach.marked += 1
        const [tail, tip] = (contact?.path ?? [
          { x: Number.NaN, y: Number.NaN },
          { x: Number.NaN, y: Number.NaN },
        ]) as [Point, Point]
        return [
          marks ? 1 : 0,
          contact === undefined ? 0 : 1,
          tail.x,
          tail.y,
          tip.x,
          tip.y,
          sideIndex(contact?.fromSide),
          sideIndex(contact?.toSide),
        ]
      })
      const wire = encodeRouting(nodes, edges)
      expect(
        firstDifference(ts, requireWasm().edge_contacts(Float64Array.from(wire.values))),
      ).toBeUndefined()
    })

    fcTest.prop(
      [
        scene.chain(([n, e]) =>
          fc.tuple(
            fc.constant(n),
            fc.constant(e),
            fc.array(bendEnds, { minLength: e.length, maxLength: e.length }),
          ),
        ),
      ],
      withDefaults(),
    )('bend routes', ([nodes, edges, ends]) => {
      const ts = edges.flatMap((edge, i) => {
        const from = rectAtEnd(nodes, edge.from)
        const to = rectAtEnd(nodes, edge.to)
        if (from === undefined || to === undefined) {
          reach.missingRect += 1
          return [-2]
        }
        const route = bendRoute(edge, from, to, ends[i] as BendRouteEnds)
        if (route !== undefined) reach.bent += 1
        else if (edge.bends !== undefined) reach.refusedBends += 1
        return routeOut(route)
      })
      const endValues = ends.flatMap((e) => [
        e.from === undefined ? 0 : 1,
        e.from?.x ?? 0,
        e.from?.y ?? 0,
        e.to === undefined ? 0 : 1,
        e.to?.x ?? 0,
        e.to?.y ?? 0,
        sideIndex(e.fromSide),
        sideIndex(e.toSide),
      ])
      const wire = encodeRouting(nodes, edges)
      const rust = requireWasm().edge_bend_routes(Float64Array.from([...wire.values, ...endValues]))
      expect(firstDifference(ts, rust)).toBeUndefined()
    })

    fcTest.prop([fc.array(fc.tuple(point, side), { minLength: 1, maxLength: 16 })], withDefaults())(
      'self-loop control points',
      (cases) => {
        const ts = cases.flatMap(([start, s]) =>
          selfEdgeLoopControlPoints(start, s).flatMap((p) => [p.x, p.y]),
        )
        const input = Float64Array.from(
          cases.flatMap(([start, s]) => [start.x, start.y, sideIndex(s)]),
        )
        expect(firstDifference(ts, requireWasm().edge_self_loop_points(input))).toBeUndefined()
      },
    )

    afterAllFloor(['initial side choices', 'contacts', 'bend routes'], () => {
      // Floors at about half of what three runs measured.
      expect(reach.choices).toBeGreaterThan(230)
      expect(reach.namedFromKept).toBeGreaterThan(90)
      expect(reach.namedToKept).toBeGreaterThan(90)
      expect(reach.partnerMoved).toBeGreaterThan(11)
      expect(reach.contacts).toBeGreaterThan(40)
      expect(reach.marked).toBeGreaterThan(33)
      expect(reach.bent).toBeGreaterThan(120)
      expect(reach.refusedBends).toBeGreaterThan(65)
      expect(reach.missingRect).toBeGreaterThan(60)
    })
  },
)
