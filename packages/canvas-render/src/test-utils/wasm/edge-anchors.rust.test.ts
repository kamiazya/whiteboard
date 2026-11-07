import { type EdgeSide, edgeSideSchema, type SpatialNode } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
import {
  type AnchorContext,
  anchorContext,
  buildAnchorGroups,
  computeAnchorsFor,
  patchAnchorGroups,
  patchWork,
} from '../../layout/edges/edge-anchors.js'
import { centerOf, type Point, rectAtEnd } from '../../layout/edges/edge-geometry.js'
import type { SidePair } from '../../layout/edges/edge-rules.js'
import type { EdgeAnchorOverride, EdgeAnchorPair } from '../../layout/edges/edge-sides.js'
import { ORTHOGONAL_STUB_PX } from '../../layout/edges/edge-sides.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { firstDifference, point } from './edge-arbitraries.js'
import { built, requireWasm } from './glue.js'
import { scene } from './routing-arbitraries.js'
import { encodeRouting, type RoutingWire } from './routing-wire.js'

/**
 * edge-anchors.ts against its Rust port through the wasm artifact (ADR-0054
 * step 5, QR-21 layer 2): the fan-out along a shared side, the lane depths,
 * the facing-pair slide, the pins, and a one-edge patch of the partition,
 * compared exactly, entry order included, since a JavaScript `Map`'s order is
 * what the search iterates.
 */

const SIDES = edgeSideSchema.options
const side = fc.constantFrom(...SIDES)
const sideIndex = (s: EdgeSide | undefined) => (s === undefined ? -1 : SIDES.indexOf(s))

/**
 * The pair facing the other box along the dominant axis, so the slide of a
 * lone facing pair has something to do; a random pair rarely faces at all.
 */
function facingPair(nodes: readonly SpatialNode[], edge: RoutableElement): SidePair {
  const a = rectAtEnd(nodes, edge.from)
  const b = rectAtEnd(nodes, edge.to)
  if (a === undefined || b === undefined) return { fromSide: 'right', toSide: 'left' }
  const [ca, cb] = [centerOf(a), centerOf(b)]
  if (Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y)) {
    return cb.x >= ca.x
      ? { fromSide: 'right', toSide: 'left' }
      : { fromSide: 'left', toSide: 'right' }
  }
  return cb.y >= ca.y
    ? { fromSide: 'bottom', toSide: 'top' }
    : { fromSide: 'top', toSide: 'bottom' }
}

const randomPair = fc
  .record({ fromSide: side, toSide: side, around: fc.boolean() })
  .map(({ around, ...p }): SidePair => (around ? { ...p, around: true } : p))

const pairFor = (nodes: readonly SpatialNode[], edge: RoutableElement) =>
  fc.oneof(randomPair, fc.constant(facingPair(nodes, edge)))

const maybe = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined })
const pinOf = (sides: SidePair) =>
  fc
    .record(
      {
        from: maybe(point),
        fromLaneDepth: maybe(fc.integer({ min: 0, max: 80 })),
        to: maybe(point),
        toLaneDepth: maybe(fc.integer({ min: 0, max: 80 })),
      },
      { requiredKeys: [] },
    )
    .map((p): EdgeAnchorOverride => ({ ...sides, ...p }))

/**
 * Two boxes facing across a gap with their tangent ranges only partly
 * overlapping, joined by one edge: the lone facing pair whose slide the
 * lane window has to clamp, which random canvases draw a few times a run.
 */
const lanePair = fc
  .record({
    // Negative overlaps the boxes, which the forward-facing test refuses.
    // Overlapping, abutting exactly (the forward test's boundary), or apart.
    gap: fc.oneof(
      fc.integer({ min: -30, max: -1 }),
      fc.constant(0),
      fc.integer({ min: 1, max: 80 }),
    ),
    h1: fc.integer({ min: 10, max: 240 }),
    h2: fc.integer({ min: 10, max: 240 }),
    dy: fc.integer({ min: -120, max: 120 }),
    vertical: fc.boolean(),
    // b before a, so the left- and top-facing arms are drawn too.
    flip: fc.boolean(),
  })
  .map(({ gap, h1, h2, dy, vertical, flip }) => {
    const box = (id: string, x: number, y: number, w: number, h: number) =>
      (vertical
        ? { id, type: 'text', text: '', x: y, y: x, width: h, height: w }
        : { id, type: 'text', text: '', x, y, width: w, height: h }) as SpatialNode
    const nodes = [
      box('lane-a', 0, 0, 40, h1),
      box('lane-b', flip ? -40 - gap : 40 + gap, dy, 40, h2),
    ]
    const edge = { id: 'lane', from: { node: 'lane-a' }, to: { node: 'lane-b' } } as RoutableElement
    // The pair facing along the axis the boxes were laid out on: centres
    // would pick the other axis once the boxes overlap.
    const facing: SidePair = vertical
      ? flip
        ? { fromSide: 'top', toSide: 'bottom' }
        : { fromSide: 'bottom', toSide: 'top' }
      : flip
        ? { fromSide: 'left', toSide: 'right' }
        : { fromSide: 'right', toSide: 'left' }
    return { nodes, edge, facing }
  })

const drawn = fc
  .tuple(
    scene.filter(([, edges]) => edges.length > 0),
    fc.option(lanePair, { nil: undefined, freq: 2 }),
  )
  .map(([[nodes, edges], lane]) =>
    lane === undefined
      ? ([nodes, edges] as const)
      : ([
          [...nodes, ...lane.nodes],
          [...edges, lane.edge],
        ] as const),
  )
  .chain(([nodes, edges]) =>
    fc.record({
      nodes: fc.constant(nodes),
      edges: fc.constant(edges),
      // Most edges sided, a few left out, in the order the search would
      // have set them.
      sides: fc.tuple(
        ...edges.map((edge) => fc.option(pairFor(nodes, edge), { nil: undefined, freq: 6 })),
      ),
      align: fc.boolean(),
      // Pins on any edges, the last (the lane pair's, when drawn) most often.
      pins: fc.option(
        fc
          .oneof(
            fc.subarray(
              edges.map((_, i) => i),
              { maxLength: Math.min(3, edges.length) },
            ),
            fc.constant([edges.length - 1]),
          )
          .chain((indices) =>
            fc.tuple(
              ...indices.map((i) =>
                fc.tuple(fc.constant(i), pinOf(facingPair(nodes, edges[i] as RoutableElement))),
              ),
            ),
          ),
        { nil: undefined, freq: 3 },
      ),
      patch: fc.option(
        fc
          .integer({ min: 0, max: edges.length - 1 })
          .chain((i) => fc.tuple(fc.constant(i), pairFor(nodes, edges[i] as RoutableElement))),
        { nil: undefined, freq: 2 },
      ),
    }),
  )

const flaggedPoint = (p: Point | undefined) => (p === undefined ? [0, 0, 0] : [1, p.x, p.y])
const flagged = (v: number | undefined) => (v === undefined ? [0, 0] : [1, v])
const pairValues = (p: SidePair) => [
  sideIndex(p.fromSide),
  sideIndex(p.toSide),
  p.around === true ? 1 : 0,
]

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

const reach = {
  entries: 0,
  laned: 0,
  slid: 0,
  crowded: 0,
  pinned: 0,
  around: 0,
  patched: 0,
  patchedSided: 0,
}

type Draw = typeof drawn extends fc.Arbitrary<infer T> ? T : never

/**
 * The lane pair alone, sided to face, aligned, and half-pinned now and then:
 * the slide, its clamp to the lane window, and the rule that a pinned edge
 * is not slid, each of which the whole-canvas draw reaches a few times.
 */
/** A lane pair's boxes and edge renamed by `suffix` and moved `dx` along x. */
function relabel(lane: LanePair, suffix: string, dx: number): LanePair {
  const id = (s: string) => `${s}${suffix}`
  return {
    nodes: lane.nodes.map((n) => ({ ...n, id: id(n.id), x: n.x + dx })),
    edge: {
      ...lane.edge,
      id: id(lane.edge.id),
      from: { node: id('lane-a') },
      to: { node: id('lane-b') },
    } as RoutableElement,
    facing: lane.facing,
  }
}

type LanePair = typeof lanePair extends fc.Arbitrary<infer T> ? T : never

/** A box the first pair's from box also connects to, through the same side. */
const crowdOf = (fromSide: EdgeSide, toSide: EdgeSide) => ({
  node: {
    id: 'lane-c',
    type: 'text',
    text: '',
    x: 300,
    y: 300,
    width: 30,
    height: 30,
  } as SpatialNode,
  edge: { id: 'lane-crowd', from: { node: 'lane-a' }, to: { node: 'lane-c' } } as RoutableElement,
  pair: { fromSide, toSide } as SidePair,
})

/**
 * Three lane pairs at a time, far apart so they never share a lane: each is
 * an independent chance at the slide, its clamp and the forward-facing test,
 * which a canvas of one pair drew too rarely to pin. The first is sometimes
 * half-pinned, and sometimes crowded by a second edge leaving its from box
 * through the same side, where it must keep its fan-out instead.
 */
const lone: fc.Arbitrary<Draw> = fc
  .tuple(
    fc.array(lanePair, { minLength: 3, maxLength: 3 }),
    fc.option(fc.oneof(fc.record({ from: point }), fc.record({ to: point })), { nil: undefined }),
    fc.option(side, { nil: undefined, freq: 2 }),
  )
  .map(([lanes, half, crowdTo]) => {
    const pairs = lanes.map((lane, i) => relabel(lane, i === 0 ? '' : `${i}`, 2000 * i))
    const first = pairs[0] as LanePair
    const crowd = crowdTo === undefined ? [] : [crowdOf(first.facing.fromSide, crowdTo)]
    return {
      nodes: [...pairs.flatMap((p) => p.nodes), ...crowd.map((c) => c.node)],
      edges: [...pairs.map((p) => p.edge), ...crowd.map((c) => c.edge)],
      sides: [...pairs.map((p) => p.facing), ...crowd.map((c) => c.pair)],
      align: true,
      pins:
        half === undefined
          ? undefined
          : [[0, { ...first.facing, ...half }] as [number, EdgeAnchorOverride]],
      patch: undefined,
    }
  })

/** The draw's side map, pins and (when patched) the re-sided map, as Maps. */
function mapsOf(d: Draw) {
  const sides = new Map<string, SidePair>()
  d.edges.forEach((edge, i) => {
    const pair = d.sides[i]
    if (pair !== undefined) sides.set(edge.id, pair)
  })
  const pins =
    d.pins === undefined || d.pins.length === 0
      ? undefined
      : new Map(d.pins.map(([i, pin]) => [(d.edges[i] as RoutableElement).id, pin]))
  const next =
    d.patch === undefined
      ? sides
      : new Map(sides).set((d.edges[d.patch[0]] as RoutableElement).id, d.patch[1])
  return { sides, pins, next }
}

type Maps = ReturnType<typeof mapsOf>

/** The TypeScript's answer: built from scratch, or patched from a base. */
function tsAnchors(d: Draw, ctx: AnchorContext, { sides, pins, next }: Maps) {
  if (d.patch === undefined)
    return { work: 0, anchors: computeAnchorsFor(ctx, sides, d.align, pins) }
  const base = buildAnchorGroups(ctx, sides)
  const work = patchWork(ctx, base, next, d.patch[0])
  const patched = patchAnchorGroups(ctx, base, next, d.patch[0])
  return { work, anchors: computeAnchorsFor(ctx, next, d.align, pins, patched) }
}

/** The same draw as `edge_compute_anchors` reads it. */
function wireInput(d: Draw, wire: RoutingWire, { sides, pins }: Maps): Float64Array {
  const idOf = (id: string) => wire.edgeIds.indexOf(id)
  return Float64Array.from([
    ...wire.values,
    sides.size,
    ...[...sides].flatMap(([id, p]) => [idOf(id), ...pairValues(p)]),
    d.align ? 1 : 0,
    pins?.size ?? 0,
    ...[...(pins ?? [])].flatMap(([id, p]) => [
      idOf(id),
      ...pairValues(p),
      ...flaggedPoint(p.from),
      ...flagged(p.fromLaneDepth),
      ...flaggedPoint(p.to),
      ...flagged(p.toLaneDepth),
    ]),
    ...(d.patch === undefined ? [-1] : [d.patch[0], ...pairValues(d.patch[1])]),
  ])
}

function tally(
  d: Draw,
  ctx: AnchorContext,
  { pins, next }: Maps,
  anchors: ReadonlyMap<string, EdgeAnchorPair>,
) {
  const unaligned = d.align ? buildAnchorGroups(ctx, next).entries : undefined
  for (const [id, e] of anchors) {
    reach.entries += 1
    if ((e.fromLaneDepth ?? 0) > ORTHOGONAL_STUB_PX || (e.toLaneDepth ?? 0) > ORTHOGONAL_STUB_PX) {
      reach.laned += 1
    }
    if (e.around === true) reach.around += 1
    if (pins?.has(id) === true) reach.pinned += 1
    const before = unaligned?.get(id)
    const moved = !Object.is(before?.from?.x, e.from?.x) || !Object.is(before?.from?.y, e.from?.y)
    if (before !== undefined && pins?.has(id) !== true && moved) reach.slid += 1
  }
}

/** Both sides' answers to one draw, compared exactly. */
function check(d: Draw) {
  const wire = encodeRouting(d.nodes, d.edges)
  const maps = mapsOf(d)
  const ctx = anchorContext(d.nodes, d.edges)
  const { work, anchors } = tsAnchors(d, ctx, maps)
  if (d.patch !== undefined) {
    reach.patched += 1
    // A patch of an edge the base already placed leaves its old groups
    // before joining the new ones; an unsided one only joins.
    if (maps.sides.has((d.edges[d.patch[0]] as RoutableElement).id)) reach.patchedSided += 1
  }
  const out = requireWasm().edge_compute_anchors(wireInput(d, wire, maps))
  const idOf = (id: string) => wire.edgeIds.indexOf(id)
  const ts = [work, anchors.size, ...[...anchors].flatMap(([id, e]) => entryValues(idOf(id), e))]
  expect(firstDifference(ts, out)).toBeUndefined()
  tally(d, ctx, maps, anchors)
  if (d.align && d.edges.some((e) => e.id === 'lane-crowd')) reach.crowded += 1
}

describe.runIf(built)('edge-anchors.ts and its Rust port place the same anchors', () => {
  fcTest.prop([drawn], withDefaults())('fan-out, lanes, slide, pins and patch', check)
  fcTest.prop([lone], withDefaults())('a lone facing pair: slide, clamp and pins', check)

  afterAllFloor(
    ['fan-out, lanes, slide, pins and patch', 'a lone facing pair: slide, clamp and pins'],
    () => {
      // About half the lowest of five measured runs (entries 1210, laned 272,
      // slid 111, crowded 90, pinned 253, around 139, patched 98, patchedSided 84).
      const floors = {
        entries: 600,
        laned: 135,
        slid: 55,
        crowded: 45,
        pinned: 125,
        around: 65,
        patched: 49,
        patchedSided: 42,
      }
      for (const [kind, floor] of Object.entries(floors)) {
        expect(reach[kind as keyof typeof reach], kind).toBeGreaterThanOrEqual(floor)
      }
    },
  )
})
