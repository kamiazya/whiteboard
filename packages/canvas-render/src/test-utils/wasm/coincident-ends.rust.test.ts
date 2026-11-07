import {
  type EdgeRoutingStyle,
  endSide,
  isSelfLoop,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
import { anchorContext, computeAnchorsFor } from '../../layout/edges/edge-anchors.js'
import type { Rect } from '../../layout/edges/edge-geometry.js'
import type { SidePair } from '../../layout/edges/edge-rules.js'
import type { EdgeAnchorOverride, EdgeAnchorPair } from '../../layout/edges/edge-sides.js'
import { createRoutingBudget } from '../../layout/edges/routing-budget.js'
import { anchorsWithoutCoincidentEnds } from '../../layout/edges/spatial-edges.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { firstDifference, rect } from './edge-arbitraries.js'
import { built, requireWasm } from './glue.js'
import { scene } from './routing-arbitraries.js'
import { encodeRouting } from './routing-wire.js'

/**
 * `anchorsWithoutCoincidentEnds` (spatial-edges.ts, over coincident-ends.ts)
 * against its Rust port through the wasm artifact (ADR-0054 step 5, QR-21
 * layer 2): which edges collided, which pair each is re-sided onto, and the
 * anchors and budget left after. In this project `./edge-router.js` is the
 * Rust router on both sides, so what this holds is the repair around it.
 */

const SIDES = ['top', 'right', 'bottom', 'left'] as const
const sideIndex = (s: string | undefined) => (s === undefined ? -1 : SIDES.indexOf(s as never))
const STYLES: Record<EdgeRoutingStyle, number> = { straight: 0, orthogonal: 1, curved: 2 }
const style = fc.constantFrom<EdgeRoutingStyle>('straight', 'orthogonal', 'curved')
const side = fc.constantFrom(...SIDES)

/**
 * Two boxes touching across a border, wired across it: their facing
 * anchors are one point, but touching boxes take the contact mark, so every
 * re-siding routes alike.
 */
const touchingPair = fc
  .record({
    w: fc.integer({ min: 10, max: 80 }),
    h: fc.integer({ min: 10, max: 80 }),
    vertical: fc.boolean(),
  })
  .map(({ w, h, vertical }) => {
    const box = (id: string, x: number, y: number) =>
      ({ id, type: 'text', text: '', x, y, width: w, height: h }) as SpatialNode
    const nodes = [box('flush-a', 0, 0), vertical ? box('flush-b', 0, h) : box('flush-b', w, 0)]
    const pair: SidePair = vertical
      ? { fromSide: 'bottom', toSide: 'top' }
      : { fromSide: 'right', toSide: 'left' }
    return { nodes, pair, reverse: false }
  })

/**
 * The repair's own case: a member flush against one border of the box
 * holding it and centred along it, wired to its holder through that side,
 * so both anchors are the side's midpoint. Contained boxes are routed, not
 * marked, so the candidates differ and the scoring decides. A third box
 * inside the holder sometimes blocks the obvious re-siding.
 */
const memberPair = fc
  .record({
    side,
    w: fc.integer({ min: 10, max: 60 }),
    h: fc.integer({ min: 10, max: 60 }),
    W: fc.integer({ min: 100, max: 260 }),
    H: fc.integer({ min: 100, max: 220 }),
    blocker: fc.boolean(),
    reverse: fc.boolean(),
  })
  .map(({ side: s, w, h, W, H, blocker, reverse }) => {
    const at = {
      left: [0, (H - h) / 2],
      right: [W - w, (H - h) / 2],
      top: [(W - w) / 2, 0],
      bottom: [(W - w) / 2, H - h],
    }[s] as [number, number]
    const box = (id: string, x: number, y: number, bw: number, bh: number) =>
      ({ id, type: 'text', text: '', x, y, width: bw, height: bh }) as SpatialNode
    const nodes = [box('flush-a', at[0], at[1], w, h), box('flush-b', 0, 0, W, H)]
    if (blocker) {
      nodes.push({
        id: 'flush-c',
        type: 'text',
        text: '',
        x: W / 2 - 8,
        y: H / 2 - 8,
        width: 16,
        height: 16,
      } as SpatialNode)
    }
    return { nodes, pair: { fromSide: s, toSide: s } as SidePair, reverse }
  })

type Named = 'none' | 'from' | 'to' | 'both'
type Flush = typeof memberPair extends fc.Arbitrary<infer T> ? T : never

/** Each drawn pair placed 1000px apart, its ids numbered, its edge named as drawn. */
function placeFlush(flush: ReadonlyArray<readonly [Flush, Named]>) {
  return flush.map(([f, named], i) => {
    const [a, b] = f.reverse ? ['flush-b', 'flush-a'] : ['flush-a', 'flush-b']
    const fromSide = named === 'from' || named === 'both' ? { side: f.pair.fromSide } : {}
    const toSide = named === 'to' || named === 'both' ? { side: f.pair.toSide } : {}
    return {
      nodes: f.nodes.map((n) => ({ ...n, id: `${n.id}${i}`, x: n.x + 1000 * (i + 1) })),
      edge: {
        id: `flush${i}`,
        from: { node: `${a}${i}`, ...fromSide },
        to: { node: `${b}${i}`, ...toSide },
      } as RoutableElement,
      pair: f.pair,
    }
  })
}

/** The pin on the first flush edge's from end, now and then on both. */
const pinDraw = fc.option(
  fc.record({
    x: fc.integer({ min: 1000, max: 1300 }),
    y: fc.integer({ min: 0, max: 220 }),
    // Both ends pinned to the one point: the edge collides and stays pinned
    // through every trial.
    both: fc.boolean(),
  }),
  { nil: undefined, freq: 4 },
)

/**
 * The repairs account: ample mostly, sometimes nothing, and sometimes a few
 * repairs' worth around the `edges + nodes` one repair charges, so the
 * search runs out partway.
 */
const repairsDraw = (charge: number) =>
  fc.oneof(
    { weight: 2, arbitrary: fc.constant(createRoutingBudget().repairs) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 60 }) },
    {
      weight: 3,
      arbitrary: fc
        .tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: -4, max: 8 }))
        .map(([n, off]) => Math.max(0, n * charge + off)),
    },
  )

const drawn = fc
  .tuple(
    scene.filter(([, edges]) => edges.length > 0),
    fc.array(
      fc.tuple(
        fc.oneof(touchingPair, memberPair, memberPair),
        // The edge naming none, one, or both of its sides: a named side
        // survives the repair, and a fully named edge is left as authored.
        fc.constantFrom<Named>('none', 'none', 'from', 'to', 'both'),
      ),
      { minLength: 1, maxLength: 3 },
    ),
    fc.boolean(),
    fc.boolean(),
  )
  .chain(([[nodes, edges], flush, withDup, withCopy]) => {
    const pairs = placeFlush(flush)
    const flushNodes = pairs.flatMap((p) => p.nodes)
    // Now and then a later edge reuses the first flush edge's id: a Map by
    // id then answers the LATER edge's index, which the repair patches by.
    const dup =
      edges[0] === undefined || !withDup ? [] : [{ ...edges[0], id: 'flush0' } as RoutableElement]
    const all = [...edges, ...pairs.map((p) => p.edge), ...dup]
    // A copy of the first holder, appended far away: a Map by id answers the
    // LAST node with an id, so the copy is the one the repair reads.
    const holder = flushNodes.find((n) => n.id === 'flush-b0')
    const copy =
      holder === undefined || !withCopy ? [] : [{ ...holder, x: holder.x + 400 } as SpatialNode]
    // A label across each holder's middle, where a re-sided route runs.
    const midLabels = flushNodes
      .filter((n) => n.id.startsWith('flush-b'))
      .map((n) => ({ x: n.x + n.width / 2 - 10, y: n.y + n.height / 2 - 10, w: 20, h: 20 }))
    return fc.record({
      nodes: fc.constant([...nodes, ...flushNodes, ...copy]),
      edges: fc.constant(all),
      sides: fc.tuple(
        ...edges.map(() =>
          fc.option(fc.record({ fromSide: side, toSide: side }), { nil: undefined, freq: 6 }),
        ),
        ...pairs.map((p) => fc.constant(p.pair as SidePair | undefined)),
        ...dup.map(() => fc.constant(undefined as SidePair | undefined)),
      ),
      styles: fc.tuple(...all.map(() => style)),
      align: fc.boolean(),
      labels: fc.oneof(
        fc.array(rect, { maxLength: 2 }),
        midLabels.length === 0 ? fc.constant([]) : fc.subarray(midLabels, { minLength: 1 }),
      ),
      pin: pinDraw,
      repairs: repairsDraw(all.length + nodes.length + flushNodes.length),
    })
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

const coincide = (e: EdgeAnchorPair | undefined) =>
  e?.from !== undefined && e.to !== undefined && e.from.x === e.to.x && e.from.y === e.to.y

const reach = { collided: 0, repaired: 0, unrepaired: 0, cutShort: 0, pinned: 0 }

describe.runIf(built)('the coincident-ends repair and its Rust port re-side the same', () => {
  fcTest.prop([drawn], withDefaults())('collisions, re-sided pairs and the budget left', (d) => {
    const wire = encodeRouting(d.nodes, d.edges)
    const idOf = (id: string) => wire.edgeIds.indexOf(id)
    const sides = new Map<string, SidePair>()
    d.edges.forEach((edge, i) => {
      const pair = d.sides[i]
      if (pair !== undefined) sides.set(edge.id, pair)
    })
    const flush0 = sides.get('flush0')
    const pins =
      d.pin === undefined || flush0 === undefined
        ? undefined
        : new Map<string, EdgeAnchorOverride>([
            [
              'flush0',
              {
                ...flush0,
                from: { x: d.pin.x, y: d.pin.y },
                ...(d.pin.both ? { to: { x: d.pin.x, y: d.pin.y } } : {}),
              },
            ],
          ])
    const labels = d.labels as readonly Rect[]
    const styleByEdge = new Map(d.edges.map((e, i) => [e, d.styles[i] as EdgeRoutingStyle]))
    const fresh = createRoutingBudget()
    const budget = { ...fresh, repairs: d.repairs }
    const ts = anchorsWithoutCoincidentEnds(
      d.nodes,
      labels,
      d.edges,
      sides,
      (e) => styleByEdge.get(e) ?? 'straight',
      d.align,
      pins,
      budget,
    )
    const input = Float64Array.from([
      ...wire.values,
      sides.size,
      ...[...sides].flatMap(([id, p]) => [idOf(id), sideIndex(p.fromSide), sideIndex(p.toSide), 0]),
      d.align ? 1 : 0,
      pins?.size ?? 0,
      ...[...(pins ?? [])].flatMap(([id, p]) => [
        idOf(id),
        sideIndex(p.fromSide),
        sideIndex(p.toSide),
        p.around === true ? 1 : 0,
        ...flaggedPoint(p.from),
        ...flagged(p.fromLaneDepth),
        ...flaggedPoint(p.to),
        ...flagged(p.toLaneDepth),
      ]),
      ...d.styles.map((s) => STYLES[s as EdgeRoutingStyle]),
      labels.length,
      ...labels.flatMap((r) => [r.x, r.y, r.w, r.h]),
      fresh.grid,
      fresh.pairs,
      fresh.trials,
      d.repairs,
    ])
    const out = requireWasm().edge_repair_coincident(input)
    const expected = [
      budget.grid,
      budget.pairs,
      budget.trials,
      budget.repairs,
      ts.size,
      ...[...ts].flatMap(([id, e]) => entryValues(idOf(id), e)),
    ]
    expect(firstDifference(expected, out)).toBeUndefined()

    // Collided as the repair's own filter reads it: not a self-loop, and
    // not naming both sides.
    const unrepaired = computeAnchorsFor(anchorContext(d.nodes, d.edges), sides, d.align, pins)
    const repairable = d.edges.filter(
      (e) =>
        !isSelfLoop(e) &&
        (endSide(e.from) === undefined || endSide(e.to) === undefined) &&
        coincide(unrepaired.get(e.id)),
    )
    for (const e of repairable) {
      reach.collided += 1
      if (!coincide(ts.get(e.id))) reach.repaired += 1
      else reach.unrepaired += 1
    }
    // A collision left standing with too little in the account for another
    // repair: the search ran out rather than finding nothing.
    const left = repairable.some((e) => coincide(ts.get(e.id)))
    if (left && budget.repairs < d.nodes.length + d.edges.length) reach.cutShort += 1
    if (pins !== undefined) reach.pinned += 1
  })

  afterAllFloor(['collisions, re-sided pairs and the budget left'], () => {
    // About half the lowest of five measured runs (collided 240, repaired
    // 35, unrepaired 174, cutShort 75, pinned 148). `collided` is the
    // repair's own filter's set, so these count what it saw.
    const floors = { collided: 120, repaired: 17, unrepaired: 85, cutShort: 37, pinned: 74 }
    for (const [kind, floor] of Object.entries(floors)) {
      expect(reach[kind as keyof typeof reach], kind).toBeGreaterThanOrEqual(floor)
    }
  })
})
