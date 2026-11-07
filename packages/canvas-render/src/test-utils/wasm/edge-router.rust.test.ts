import { type EdgeRoutingStyle, edgeSideSchema, type SpatialNode } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
import { type Rect, rectAtEnd, rectOf, sidePoint } from '../../layout/edges/edge-geometry.js'
import { routeEdge as routeTs } from '../../layout/edges/edge-router.js'
import type { EdgeAnchorPair } from '../../layout/edges/edge-sides.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { firstDifference, point, rect } from './edge-arbitraries.js'
import { routeEdge as routeRust } from './edge-router.js'
import { built } from './glue.js'
import { scene } from './routing-arbitraries.js'

/**
 * `routeEdge` against its Rust port through the wasm artifact (ADR-0054
 * step 5, QR-21 layer 2). Layer 1 runs every layout/edges suite through the
 * Rust router; this compares the two routers directly on canvases those
 * suites never draw, every coordinate exact and the grid budget spent too.
 * In this project the TypeScript router's own grid search is aliased to the
 * Rust port as well, so what this holds is the router around it; the grid
 * search has its own differential (grid-route.rust.test.ts).
 */

const side = fc.constantFrom(...edgeSideSchema.options)
const style = fc.constantFrom<EdgeRoutingStyle>('straight', 'orthogonal', 'curved')
const maybe = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined })
const anchors = fc.option(
  fc.record(
    {
      from: maybe(point),
      to: maybe(point),
      fromLaneDepth: maybe(fc.integer({ min: 0, max: 60 })),
      toLaneDepth: maybe(fc.integer({ min: 0, max: 60 })),
      fromSide: maybe(side),
      toSide: maybe(side),
      around: maybe(fc.constant(true as const)),
    },
    { requiredKeys: [] },
  ),
  { nil: undefined, freq: 2 },
) as fc.Arbitrary<EdgeAnchorPair | undefined>

/**
 * Small boxes tiled around the edge's own two ends, corridors narrower than
 * the router's clearance between them and none within 40px of either end:
 * every elbow and enumerated detour is blocked, so the grid search runs.
 */
const lattice = (ends: readonly Rect[]) =>
  fc
    .record({ cell: fc.integer({ min: 6, max: 30 }), gap: fc.integer({ min: 10, max: 36 }) })
    .map(({ cell, gap }) => {
      const placed = ends.filter((r) => [r.x, r.y, r.w, r.h].every((v) => Math.abs(v) < 1e4))
      if (placed.length === 0) return []
      const x0 = Math.min(...placed.map((r) => r.x)) - 160
      const y0 = Math.min(...placed.map((r) => r.y)) - 160
      const x1 = Math.max(...placed.map((r) => r.x + r.w)) + 160
      const y1 = Math.max(...placed.map((r) => r.y + r.h)) + 160
      const pitch = cell + gap
      const cols = Math.min(30, Math.ceil((x1 - x0) / pitch))
      const rows = Math.min(30, Math.ceil((y1 - y0) / pitch))
      const away = (c: Rect) =>
        placed.every(
          (r) =>
            c.x + c.w < r.x - 40 ||
            c.x > r.x + r.w + 40 ||
            c.y + c.h < r.y - 40 ||
            c.y > r.y + r.h + 40,
        )
      return Array.from({ length: cols * rows }, (_, i) => ({
        x: x0 + (i % cols) * pitch,
        y: y0 + Math.floor(i / cols) * pitch,
        w: cell,
        h: cell,
      })).filter(away)
    })

const endsOf = (nodes: readonly SpatialNode[], edge: RoutableElement) =>
  [rectAtEnd(nodes, edge.from), rectAtEnd(nodes, edge.to)].filter((r): r is Rect => r !== undefined)

/**
 * A call aimed at the grid search: orthogonal, no stored bends (the bend
 * route answers before any search), a maze around the ends and a budget
 * that never runs out. Drawn beside the general call because the general
 * one reaches the search a few times a run at best.
 */
const mazeCall = (nodes: readonly SpatialNode[], edges: readonly RoutableElement[]) =>
  fc.constantFrom(...edges).chain((drawn) => {
    const { bends: _, ...edge } = drawn as RoutableElement & { bends?: unknown }
    return fc.record({
      edge: fc.constant(edge as RoutableElement),
      style: fc.constant<EdgeRoutingStyle>('orthogonal'),
      anchors,
      others: lattice(endsOf(nodes, edge as RoutableElement)),
      grid: fc.constant(64_000_000),
      labels: fc.constant([]),
    })
  })

/**
 * A box on each elbow's corner, so both elbows are blocked and the four ways
 * around them are left: the enumerated detours' own case.
 */
const cornerBlockers = (ends: readonly Rect[]) =>
  fc.integer({ min: 4, max: 30 }).map((half) => {
    const [a, b] = ends
    if (a === undefined || b === undefined) return []
    const box = (x: number, y: number) => ({ x: x - half, y: y - half, w: 2 * half, h: 2 * half })
    const [ax, ay] = [a.x + a.w / 2, a.y + a.h / 2]
    const [bx, by] = [b.x + b.w / 2, b.y + b.h / 2]
    return [box(ax, by), box(bx, ay)]
  })

/**
 * Labels anywhere, or over the middle of one of the edge's own sides, where
 * a label holding an anchor has to leave the obstacle set.
 */
const labelsOver = (ends: readonly Rect[]) =>
  fc.oneof(
    fc.array(rect, { maxLength: 2 }),
    fc
      .tuple(fc.constantFrom(...ends), side, fc.integer({ min: 2, max: 30 }))
      .map(([r, s, half]) => {
        const p = sidePoint(r, s)
        return [{ x: p.x - half, y: p.y - half, w: 2 * half, h: 2 * half }]
      }),
  )

/** One edge's routing call: its style, anchors, `others`, budget and labels. */
const generalCall = (nodes: readonly SpatialNode[], edges: readonly RoutableElement[]) =>
  fc.constantFrom(...edges).chain((edge) => {
    const ends = endsOf(nodes, edge)
    return fc.record({
      edge: fc.constant(edge),
      style,
      anchors,
      // A crowd of boxes as `others` now and then, and a maze around the
      // edge's ends most often, where the enumerated detours all fail.
      others: fc.option(
        fc.oneof(
          { weight: 1, arbitrary: fc.constant(nodes.map(rectOf)) },
          { weight: 1, arbitrary: fc.array(rect, { maxLength: 6 }) },
          { weight: 1, arbitrary: fc.array(rect, { minLength: 12, maxLength: 30 }) },
          { weight: 3, arbitrary: lattice(ends) },
          { weight: 3, arbitrary: cornerBlockers(ends) },
        ),
        { nil: undefined, freq: 3 },
      ),
      // An unbounded account too, which the TypeScript leaves at Infinity.
      grid: fc.option(
        fc.oneof(
          fc.integer({ min: 0, max: 2000 }),
          fc.constant(64_000_000),
          fc.constant(Number.POSITIVE_INFINITY),
        ),
        { nil: undefined },
      ),
      labels: ends.length === 0 ? fc.array(rect, { maxLength: 2 }) : labelsOver(ends),
    })
  })

const call = (nodes: readonly SpatialNode[], edges: readonly RoutableElement[]) =>
  fc.oneof(
    { weight: 3, arbitrary: generalCall(nodes, edges) },
    { weight: 1, arbitrary: mazeCall(nodes, edges) },
  )

const routed = scene
  .filter(([, edges]) => edges.length > 0)
  .chain(([nodes, edges]) =>
    fc.tuple(fc.constant(nodes), fc.array(call(nodes, edges), { minLength: 1, maxLength: 6 })),
  )

const flat = (r: ResolvedEdgeNode) => [
  r.rounded === true ? 1 : 0,
  edgeSideSchema.options.indexOf(r.fromSide ?? 'top'),
  edgeSideSchema.options.indexOf(r.toSide ?? 'top'),
  r.fromEnd === 'arrow' ? 1 : 0,
  r.toEnd === 'arrow' ? 1 : 0,
  r.path.length,
  ...r.path.flatMap((p) => [p.x, p.y]),
]

const reach = {
  straight: 0,
  orthogonal: 0,
  curved: 0,
  detoured: 0,
  gridSpent: 0,
  unbounded: 0,
  anchored: 0,
  labelOverEnd: 0,
}

/** Whether a label holds a point strictly, the case `routeObstacles` drops it for. */
const holds = (r: Rect, p: { x: number; y: number }) =>
  p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h

describe.runIf(built)('edge-router.ts and its Rust port route the same', () => {
  fcTest.prop([routed], withDefaults())('route, sides and grid spend', ([nodes, calls]) => {
    for (const c of calls) {
      const tsBudget =
        c.grid === undefined ? undefined : { grid: c.grid, pairs: 0, trials: 0, repairs: 0 }
      const rustBudget =
        c.grid === undefined ? undefined : { grid: c.grid, pairs: 0, trials: 0, repairs: 0 }
      const others = c.others as readonly Rect[] | undefined
      const ts = routeTs(nodes, c.edge, c.style, c.anchors, others, tsBudget, c.labels)
      const rust = routeRust(nodes, c.edge, c.style, c.anchors, others, rustBudget, c.labels)
      reach[c.style] += 1
      // An elbow is at most five points (start, stub, corner, stub, end);
      // more, with no stored bends, is a detour or a searched route.
      const bent = (c.edge as { bends?: unknown }).bends !== undefined
      if (c.style !== 'straight' && !bent && ts.path.length > 5) reach.detoured += 1
      if (tsBudget !== undefined && tsBudget.grid < (c.grid as number)) reach.gridSpent += 1
      if (c.grid === Number.POSITIVE_INFINITY) reach.unbounded += 1
      if (c.anchors !== undefined && Object.values(c.anchors).some((v) => v !== undefined)) {
        reach.anchored += 1
      }
      const first = ts.path[0]
      const last = ts.path[ts.path.length - 1]
      if (c.labels.some((l) => [first, last].some((p) => p !== undefined && holds(l, p)))) {
        reach.labelOverEnd += 1
      }
      expect(firstDifference(flat(ts), Float64Array.from(flat(rust)))).toBeUndefined()
      expect(rustBudget?.grid).toBe(tsBudget?.grid)
    }
  })

  afterAllFloor(['route, sides and grid spend'], () => {
    // About half the lowest of eight measured runs (straight 149, orthogonal
    // 308, curved 156, detoured 14, gridSpent 23, unbounded 136, anchored 332,
    // labelOverEnd 79). `detoured` is honest and low: most canvases leave an
    // elbow clear, and the layer-1 suites carry the detours' dense cases.
    const floors = {
      straight: 70,
      orthogonal: 150,
      curved: 75,
      detoured: 7,
      gridSpent: 11,
      unbounded: 65,
      anchored: 160,
      labelOverEnd: 39,
    }
    for (const [kind, floor] of Object.entries(floors)) {
      expect(reach[kind as keyof typeof reach], kind).toBeGreaterThanOrEqual(floor)
    }
  })
})
