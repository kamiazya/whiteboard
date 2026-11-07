import type { EdgeRoutingStyle, SpatialNode } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
import { anchorContext, computeAnchorsFor } from '../../layout/edges/edge-anchors.js'
import type { Rect } from '../../layout/edges/edge-geometry.js'
import type { SidePair } from '../../layout/edges/edge-rules.js'
import type { EdgeAnchorPair } from '../../layout/edges/edge-sides.js'
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

const drawn = fc
  .tuple(
    scene.filter(([, edges]) => edges.length > 0),
    fc.array(
      fc.tuple(
        fc.oneof(touchingPair, memberPair, memberPair),
        // The edge naming none, its from, or both of its sides: a named side
        // survives the repair, and a fully named edge is left as authored.
        fc.constantFrom('none', 'none', 'from', 'both'),
      ),
      { minLength: 1, maxLength: 3 },
    ),
  )
  .chain(([[nodes, edges], flush]) => {
    const pairs = flush.map(([f, named], i) => {
      const [a, b] = f.reverse ? ['flush-b', 'flush-a'] : ['flush-a', 'flush-b']
      const fromSide = named === 'none' ? {} : { side: f.pair.fromSide }
      const toSide = named === 'both' ? { side: f.pair.toSide } : {}
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
    // Now and then a later edge reuses the first flush edge's id: a Map by
    // id then answers the LATER edge's index, which the repair patches by.
    const allEdges = [...edges, ...pairs.map((p) => p.edge)]
    const dup = edges[0] === undefined ? [] : [{ ...edges[0], id: 'flush0' } as RoutableElement]
    return fc.boolean().chain((withDup) => {
      const all = withDup ? [...allEdges, ...dup] : allEdges
      return fc.record({
        nodes: fc.constant([...nodes, ...pairs.flatMap((p) => p.nodes)]),
        edges: fc.constant(all),
        sides: fc.tuple(
          ...edges.map(() =>
            fc.option(fc.record({ fromSide: side, toSide: side }), { nil: undefined, freq: 6 }),
          ),
          ...pairs.map((p) => fc.constant(p.pair as SidePair | undefined)),
          ...(withDup ? dup : []).map(() => fc.constant(undefined as SidePair | undefined)),
        ),
        styles: fc.tuple(...all.map(() => style)),
        align: fc.boolean(),
        labels: fc.array(rect, { maxLength: 2 }),
        // Most runs leave the repairs account ample; some cut it short.
        repairs: fc.oneof(
          { weight: 3, arbitrary: fc.constant(createRoutingBudget().repairs) },
          { weight: 1, arbitrary: fc.integer({ min: 0, max: 60 }) },
        ),
      })
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

const reach = { collided: 0, repaired: 0, unrepaired: 0, cutShort: 0 }

describe.runIf(built)('the coincident-ends repair and its Rust port re-side the same', () => {
  fcTest.prop([drawn], withDefaults())('collisions, re-sided pairs and the budget left', (d) => {
    const wire = encodeRouting(d.nodes, d.edges)
    const idOf = (id: string) => wire.edgeIds.indexOf(id)
    const sides = new Map<string, SidePair>()
    d.edges.forEach((edge, i) => {
      const pair = d.sides[i]
      if (pair !== undefined) sides.set(edge.id, pair)
    })
    const styleByEdge = new Map(d.edges.map((e, i) => [e, d.styles[i] as EdgeRoutingStyle]))
    const fresh = createRoutingBudget()
    const budget = { ...fresh, repairs: d.repairs }
    const ts = anchorsWithoutCoincidentEnds(
      d.nodes,
      d.labels as readonly Rect[],
      d.edges,
      sides,
      (e) => styleByEdge.get(e) ?? 'straight',
      d.align,
      undefined,
      budget,
    )
    const input = Float64Array.from([
      ...wire.values,
      sides.size,
      ...[...sides].flatMap(([id, p]) => [idOf(id), sideIndex(p.fromSide), sideIndex(p.toSide), 0]),
      d.align ? 1 : 0,
      0,
      ...d.styles.map((s) => STYLES[s as EdgeRoutingStyle]),
      d.labels.length,
      ...d.labels.flatMap((r) => [r.x, r.y, r.w, r.h]),
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

    const unrepaired = computeAnchorsFor(anchorContext(d.nodes, d.edges), sides, d.align)
    for (const [id, e] of unrepaired) {
      if (!coincide(e)) continue
      reach.collided += 1
      if (!coincide(ts.get(id))) reach.repaired += 1
      else reach.unrepaired += 1
    }
    // A small account with a collision left standing: the search ran out.
    const left = [...unrepaired].some(([id, e]) => coincide(e) && coincide(ts.get(id)))
    if (d.repairs <= 60 && left) reach.cutShort += 1
  })

  afterAllFloor(['collisions, re-sided pairs and the budget left'], () => {
    // About half the lowest of five measured runs (collided 338, repaired
    // 160, unrepaired 161, cutShort 38).
    const floors = { collided: 165, repaired: 80, unrepaired: 80, cutShort: 19 }
    for (const [kind, floor] of Object.entries(floors)) {
      expect(reach[kind as keyof typeof reach], kind).toBeGreaterThanOrEqual(floor)
    }
  })
})
