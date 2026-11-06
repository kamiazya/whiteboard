// The routing SCOREBOARD for the straight style, which is what a canvas with
// no routing facet and no theme draws. `edge-routing-quality.test.ts` judges
// the orthogonal style only, so nothing measured what a straight connection
// costs once something stands in its way — and what it cost was a detour
// several times the direct distance, around a box covering everything in the
// way at once.
//
// The columns a reader of a straight connection judges it by:
//
// - DEBT: `violations`/`interiorInk` (a line through a body it could have
//   gone around, with `routeEdge`'s exemption for a rect strictly containing
//   an anchor) and, on framed boards, `titleCrossings` (an edge drawn
//   through a frame's title text, which sits above the frame's border and so
//   outside every node rect).
// - PRICE: `length` against `direct` (the distance between the two drawn
//   ends), `worstRatio` (the single longest detour relative to its direct
//   distance), `grazingEnds` (a first or last leg running within ~14
//   degrees of the side it leaves or reaches, so it meets the box edge-on),
//   `bends`, `crossings` and `borderInk`. A change that buys
//   shorter routes with ink through a body or a title is a trade to state,
//   not a win.
//
// Pinned EXACTLY, so an improvement is as loud as a regression. Metrics are
// `routing-metrics.ts`'s independent oracle and never call the router's own
// scoring.
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { endNode, isFrame } from '@kamiazya/whiteboard-model'
import type { TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import {
  latticeLayouts,
  type RoutingCase,
  stackedFrameLayouts,
  stackedFramesBoard,
  syntheticLayouts,
} from '../../test-utils/routing-corpus.js'
import {
  bends,
  borderInk,
  crossings,
  interiorInk,
  type MetricPoint,
  type MetricRect,
  pathLength,
} from '../../test-utils/routing-metrics.js'
import { layoutSpatialCanvas } from '../spatial-canvas.js'
import { routeEdge } from './edge-router.js'
import type { RoutingBudget } from './routing-budget.js'
import { assignEdgeAnchors } from './spatial-edges.js'

type Path = readonly MetricPoint[]

const rectOf = (n: SpatialNode): MetricRect => ({ x: n.x, y: n.y, w: n.width, h: n.height })

const strictlyInside = (r: MetricRect, p: MetricPoint) =>
  p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h

/** Every edge routed straight, anchors assigned together, as the layout does. */
function routeStraight(testCase: RoutingCase, budget?: RoutingBudget): Map<string, Path> {
  const anchors = assignEdgeAnchors(testCase.nodes, testCase.edges, 'straight', undefined, budget)
  return new Map(
    testCase.edges.map((edge) => [
      edge.id,
      routeEdge(testCase.nodes, edge, 'straight', anchors.get(edge.id)).path,
    ]),
  )
}

/** Paths and frame title boxes from the real layout pipeline at its default geometry, straight by default. */
function layoutStraight(testCase: RoutingCase): { paths: Map<string, Path>; titles: MetricRect[] } {
  const canvas: SpatialCanvas = { nodes: [...testCase.nodes], edges: [...testCase.edges] }
  const scene = layoutSpatialCanvas(canvas, {
    measure: createFakeMeasure(),
    parseBody: (text: string) => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }),
    appearance: {
      resolveNode: () => ({}),
      resolveEdge: () => ({ stroke: '#606060' }),
      resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
    },
  })
  const frames = new Set(testCase.nodes.filter((n) => isFrame(n)).map((n) => n.id))
  const paths = new Map<string, Path>()
  const titles: MetricRect[] = []
  for (const entry of scene.nodes) {
    if (entry.kind === 'edge' && entry.id !== undefined) paths.set(entry.id, entry.path)
    const run = entry as TextRunNode
    if (run.kind === 'textRun' && run.annotates?.kind === 'node' && frames.has(run.annotates.id)) {
      titles.push(run.bbox)
    }
  }
  return { paths, titles }
}

/** A route this much longer than its direct distance reads as a detour, not a line. */
const LONG_DETOUR_RATIO = 1.5

/** Below this outward-to-along ratio (~14 degrees) a leg reads as running along the side it ends on. */
const GRAZING_RATIO = 0.25

/**
 * Whether the leg from `anchor` to `next` meets `rect` edge-on: `anchor` lies
 * on one of its sides and the leg runs nearly along that side, so the line
 * (and an arrowhead on it) slides into the box rather than arriving at it.
 */
function grazes(anchor: MetricPoint, next: MetricPoint, rect: MetricRect): boolean {
  const sides = [
    { d: Math.abs(anchor.x - rect.x), n: { x: -1, y: 0 } },
    { d: Math.abs(anchor.x - (rect.x + rect.w)), n: { x: 1, y: 0 } },
    { d: Math.abs(anchor.y - rect.y), n: { x: 0, y: -1 } },
    { d: Math.abs(anchor.y - (rect.y + rect.h)), n: { x: 0, y: 1 } },
  ].sort((a, b) => a.d - b.d)
  const side = sides[0]
  if (side === undefined || side.d > 0.5) return false
  const vx = next.x - anchor.x
  const vy = next.y - anchor.y
  if (vx === 0 && vy === 0) return false
  const outward = side.n.x * vx + side.n.y * vy
  const along = Math.abs(side.n.x * vy - side.n.y * vx)
  return outward <= along * GRAZING_RATIO
}

type Board = {
  violations: { foreign: number; 'own-endpoint': number }
  interiorInk: number
  titleCrossings: number
  length: number
  direct: number
  ratio: number
  worstRatio: number
  longDetours: number
  grazingEnds: number
  bends: number
  crossings: number
  borderInk: number
}

/** Running totals over every edge scored, rounded only when reported. */
type Tally = Omit<Board, 'ratio' | 'worstRatio'> & { worst: number }

function score(
  cases: readonly RoutingCase[],
  route: (testCase: RoutingCase) => { paths: Map<string, Path>; titles: MetricRect[] },
): Board {
  const tally: Tally = {
    violations: { foreign: 0, 'own-endpoint': 0 },
    interiorInk: 0,
    titleCrossings: 0,
    length: 0,
    direct: 0,
    worst: 1,
    longDetours: 0,
    grazingEnds: 0,
    bends: 0,
    crossings: 0,
    borderInk: 0,
  }
  for (const testCase of cases) {
    const { paths, titles } = route(testCase)
    const drawn: Path[] = []
    for (const edge of testCase.edges as readonly CanvasEdge[]) {
      const path = paths.get(edge.id)
      if (path === undefined || path.length < 2) continue
      drawn.push(path)
      scoreEdge(tally, testCase, edge, path, titles)
    }
    tally.crossings += crossings(drawn)
  }
  const { worst, ...totals } = tally
  return {
    ...totals,
    interiorInk: Math.round(tally.interiorInk),
    length: Math.round(tally.length),
    direct: Math.round(tally.direct),
    ratio: Math.round((tally.length / tally.direct) * 1000) / 1000,
    worstRatio: Math.round(worst * 100) / 100,
    borderInk: Math.round(tally.borderInk),
  }
}

/** Adds one routed edge's columns to `tally`. */
function scoreEdge(
  tally: Tally,
  testCase: RoutingCase,
  edge: CanvasEdge,
  path: Path,
  titles: readonly MetricRect[],
): void {
  const start = path[0] as MetricPoint
  const end = path[path.length - 1] as MetricPoint
  const span = Math.hypot(end.x - start.x, end.y - start.y)
  const travelled = pathLength(path)
  tally.length += travelled
  tally.direct += span
  if (span > 0) tally.worst = Math.max(tally.worst, travelled / span)
  if (travelled > LONG_DETOUR_RATIO * span) tally.longDetours++
  tally.bends += bends(path)
  const fromNode = testCase.nodes.find((n) => n.id === endNode(edge.from))
  const toNode = testCase.nodes.find((n) => n.id === endNode(edge.to))
  if (fromNode && grazes(start, path[1] as MetricPoint, rectOf(fromNode))) tally.grazingEnds++
  if (toNode && grazes(end, path[path.length - 2] as MetricPoint, rectOf(toNode))) {
    tally.grazingEnds++
  }
  for (const n of testCase.nodes) {
    const rect = rectOf(n)
    tally.borderInk += borderInk(path, rect)
    if (strictlyInside(rect, start) || strictlyInside(rect, end)) continue
    const ink = interiorInk(path, rect)
    if (ink <= 0) continue
    const own = n.id === endNode(edge.from) || n.id === endNode(edge.to)
    tally.violations[own ? 'own-endpoint' : 'foreign']++
    tally.interiorInk += ink
  }
  if (titles.some((title) => interiorInk(path, title) > 0)) tally.titleCrossings++
}

const routedOnly = (testCase: RoutingCase) => ({ paths: routeStraight(testCase), titles: [] })

/**
 * The side search with nothing left in the layout's account, so it ends on
 * whatever it was seeded with — the board a budget runs out on.
 */
const routedOnSpentBudget = (testCase: RoutingCase) => ({
  paths: routeStraight(testCase, { grid: 0, pairs: 0, trials: 0, repairs: 0 }),
  titles: [],
})

// The pins below moved when a blocked straight connection stopped going
// round one box covering everything in its way and started taking the
// shortest path through the corners of the boxes actually blocking it
// (`straight-detour.ts`), with a perpendicular stub on any first or last leg
// that would otherwise meet its box at a glancing angle (`squareEnds`).
// Every board got shorter relative to its direct distance, long detours
// fell 66 -> 5 and 245 -> 130, and border ink went to zero everywhere but
// the synthetic corpus (10530 -> 879). What it paid, stated so nobody has
// to rediscover it:
//
// - crossings rose on the framed boards (persona 0 -> 3, generated 76 ->
//   107) and fell everywhere else (synthetic 248 -> 187, lattice 724 ->
//   592). A diagonal through a corner gap crosses a neighbour the old
//   detour's outer lane went round.
// - synthetic `foreign` 21 -> 25 while `own-endpoint` fell 52 -> 20 and
//   interior ink 5763 -> 3446. Each new foreign one crossed a box the router
//   never saw: one touched on its border by an anchor was dropped from the
//   obstacles (closed below).
// - `grazingEnds` 2/111/374/209 -> 1/110/119/0 (persona, generated,
//   synthetic, lattice). The corner paths alone made it 5/386/167/118 — a
//   leg on from a corner beside the target can arrive nearly along its
//   side — which is what the stubs are for; they cost bends (persona
//   8 -> 9, lattice 1422 -> 1434, generated 841 -> 864).
// - `titleCrossings` 114 -> 0 on the generated boards and 1 -> 0 on the
//   persona board, once the layout handed the measured title boxes to the
//   router and to the side search's cost model alike (the title is text,
//   and routing is measure-free, so neither could see it on its own). Going
//   round a title is longer: on the generated boards long detours 5 -> 16,
//   worst ratio 1.58 -> 2.37, bends 864 -> 1008, crossings 107 -> 109.
//
// Then the side search was given the old route back as a CANDIDATE
// (`SidePair.around`: step round everything in the way, leaving and arriving
// along the sides' normals), tried after every corner route, so it is taken
// only where the corner routes cross something it does not. Crossings
// persona 3 -> 1, generated 109 -> 72 (76 before any corner route),
// synthetic 187 -> 164, lattice 592 -> 531; paid in length (generated
// ratio 1.12 -> 1.16, long detours 16 -> 32; lattice long detours 3 -> 16,
// worst 1.53 -> 2.04). A frame title's margin dropped to 2px at the same
// time, since a box's 8px turned a line passing a title's end aside.
//
// Then the search STARTED from stepping round and took the corner route
// wherever that cost nothing (`shorten`), since starting from the corner
// routes left crossings only a move of two edges at once could undo.
// Crossings generated 72 -> 70, synthetic 164 -> 161, violations 25/20 ->
// 22/19 and interior ink 3418 -> 2898; long detours generated 32 -> 37.
// The persona board stays at 1 crossing: every configuration with none
// steps BOTH a1->b6 and a3->b1 round (2869px or more against 2304), and no
// single-edge move reaches one.
//
// Then a box an anchor only TOUCHES stayed an obstacle for the straight
// style (escaped by its strict interior), as the side search's cost model
// already treated it. Synthetic foreign 22 -> 7, interior ink 2898 ->
// 1765; crossings 161 -> 166, long detours 152 -> 157, worst 7.67 -> 8.4.
//
// Then every straight shape got its glancing end squared, not only the one
// with neither end sideways; an end slid along its side to meet a corridor
// stays put when that corridor detours anyway; and an escaped obstacle is
// tested by its OPEN interior rather than a half-pixel inset. grazingEnds
// 1/89/114/3 -> 0/28/111/0 (persona, generated, synthetic, lattice),
// synthetic foreign 7 -> 2 and interior ink 1765 -> 1382, worst generated
// 2.37 -> 2.03; crossings generated 70 -> 72, synthetic 166 -> 170.
describe('straight routing quality', () => {
  it('reports the stacked-frames board', () => {
    expect(score([{ name: 'stacked frames', ...stackedFramesBoard() }], layoutStraight)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 0,
      // 2618/1860 (1.408), worst 1.69 before the corner detours.
      length: 2323,
      direct: 1673,
      ratio: 1.388,
      worstRatio: 1.59,
      longDetours: 1,
      grazingEnds: 0,
      bends: 12,
      crossings: 1,
      borderInk: 0,
    })
  })

  it('reports generated stacked-frame boards', { timeout: 120_000 }, () => {
    expect(score(stackedFrameLayouts(200), layoutStraight)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 0,
      // ratio 1.194, worst 1.91, 66 long detours before.
      length: 289633,
      direct: 250787,
      ratio: 1.155,
      worstRatio: 2.03,
      longDetours: 38,
      grazingEnds: 28,
      bends: 1054,
      crossings: 72,
      borderInk: 0,
    })
  })

  it('reports the synthetic corpus', { timeout: 180_000 }, () => {
    expect(score(syntheticLayouts(2000), routedOnly)).toEqual({
      violations: { foreign: 2, 'own-endpoint': 20 },
      interiorInk: 1382,
      titleCrossings: 0,
      // ratio 1.116, worst 11.63, 245 long detours before.
      length: 867660,
      direct: 800853,
      ratio: 1.083,
      worstRatio: 7.67,
      longDetours: 160,
      grazingEnds: 111,
      bends: 2082,
      crossings: 170,
      borderInk: 941,
    })
  })

  it('reports lattice boards', { timeout: 180_000 }, () => {
    expect(score(latticeLayouts(400), routedOnly)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 0,
      // ratio 1.068, worst 2.01, 26 long detours before.
      length: 1188783,
      direct: 1147648,
      ratio: 1.036,
      worstRatio: 2.04,
      longDetours: 16,
      grazingEnds: 0,
      bends: 1520,
      crossings: 529,
      borderInk: 0,
    })
  })

  // A layout whose account runs out ends its side search on what the search
  // was seeded with, so these two rows price that state on its own: every
  // straight edge as the search left it with no trial affordable.
  it('reports generated stacked-frame boards on a spent routing budget', {
    timeout: 120_000,
  }, () => {
    expect(score(stackedFrameLayouts(200), routedOnSpentBudget)).toEqual({
      violations: { foreign: 42, 'own-endpoint': 0 },
      interiorInk: 4175,
      titleCrossings: 0,
      length: 298395,
      direct: 235649,
      ratio: 1.266,
      worstRatio: 1.79,
      longDetours: 87,
      grazingEnds: 0,
      bends: 1438,
      crossings: 278,
      borderInk: 0,
    })
  })

  it('reports lattice boards on a spent routing budget', { timeout: 180_000 }, () => {
    expect(score(latticeLayouts(400), routedOnSpentBudget)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 0,
      length: 1263510,
      direct: 1138042,
      ratio: 1.11,
      worstRatio: 1.83,
      longDetours: 43,
      grazingEnds: 0,
      bends: 2675,
      crossings: 1387,
      borderInk: 0,
    })
  })
})
