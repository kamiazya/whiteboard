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
//   distance), `bends`, `crossings` and `borderInk`. A change that buys
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
import { assignEdgeAnchors } from './spatial-edges.js'

type Path = readonly MetricPoint[]

const rectOf = (n: SpatialNode): MetricRect => ({ x: n.x, y: n.y, w: n.width, h: n.height })

const strictlyInside = (r: MetricRect, p: MetricPoint) =>
  p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h

/** Every edge routed straight, anchors assigned together, as the layout does. */
function routeStraight(testCase: RoutingCase): Map<string, Path> {
  const anchors = assignEdgeAnchors(testCase.nodes, testCase.edges, 'straight')
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

type Board = {
  violations: { foreign: number; 'own-endpoint': number }
  interiorInk: number
  titleCrossings: number
  length: number
  direct: number
  ratio: number
  worstRatio: number
  longDetours: number
  bends: number
  crossings: number
  borderInk: number
}

function score(
  cases: readonly RoutingCase[],
  route: (testCase: RoutingCase) => { paths: Map<string, Path>; titles: MetricRect[] },
): Board {
  const violations = { foreign: 0, 'own-endpoint': 0 }
  let interior = 0
  let titleCrossings = 0
  let length = 0
  let direct = 0
  let worst = 1
  let longDetours = 0
  let bendCount = 0
  let crossingCount = 0
  let border = 0
  for (const testCase of cases) {
    const { paths, titles } = route(testCase)
    const drawn: Path[] = []
    for (const edge of testCase.edges as readonly CanvasEdge[]) {
      const path = paths.get(edge.id)
      const start = path?.[0]
      const end = path?.[path.length - 1]
      if (path === undefined || start === undefined || end === undefined) continue
      drawn.push(path)
      const span = Math.hypot(end.x - start.x, end.y - start.y)
      const travelled = pathLength(path)
      length += travelled
      direct += span
      if (span > 0) worst = Math.max(worst, travelled / span)
      if (travelled > LONG_DETOUR_RATIO * span) longDetours++
      bendCount += bends(path)
      for (const n of testCase.nodes) {
        const rect = rectOf(n)
        border += borderInk(path, rect)
        if (strictlyInside(rect, start) || strictlyInside(rect, end)) continue
        const ink = interiorInk(path, rect)
        if (ink <= 0) continue
        const own = n.id === endNode(edge.from) || n.id === endNode(edge.to)
        violations[own ? 'own-endpoint' : 'foreign']++
        interior += ink
      }
      if (titles.some((title) => interiorInk(path, title) > 0)) titleCrossings++
    }
    crossingCount += crossings(drawn)
  }
  return {
    violations,
    interiorInk: Math.round(interior),
    titleCrossings,
    length: Math.round(length),
    direct: Math.round(direct),
    ratio: Math.round((length / direct) * 1000) / 1000,
    worstRatio: Math.round(worst * 100) / 100,
    longDetours,
    bends: bendCount,
    crossings: crossingCount,
    borderInk: Math.round(border),
  }
}

const routedOnly = (testCase: RoutingCase) => ({ paths: routeStraight(testCase), titles: [] })

// The pins below moved once, when a blocked straight connection stopped going
// round one box covering everything in its way and started taking the
// shortest path through the corners of the boxes actually blocking it
// (`straight-detour.ts`). Every board got shorter and lost every pixel of
// border ink, since a corner path never runs along a box's side. What it
// paid, stated so nobody has to rediscover it:
//
// - crossings rose on the framed boards (persona 0 -> 3, generated 76 ->
//   112) and fell everywhere else (synthetic 248 -> 188, lattice 724 ->
//   590). A diagonal through a corner gap crosses a neighbour the old
//   detour's outer lane went round.
// - synthetic `foreign` 21 -> 25 while `own-endpoint` fell 52 -> 20 and
//   interior ink 5763 -> 3494. Each of the four new ones crosses a box the
//   router never saw: one touched on its border by an anchor is dropped from
//   the obstacles, and the side search, seeing different routes, now
//   settles on anchors that touch it.
// - `titleCrossings` 114 -> 80 on the generated boards and still 1 on the
//   persona board. The router does not know where a frame's title is — the
//   title is text, measured, and routing is measure-free — so this column
//   falls only as a side effect of shorter routes. Making it zero means
//   handing the measured title boxes to the router and to the side search's
//   cost model alike.
describe('straight routing quality', () => {
  it('reports the stacked-frames board', () => {
    expect(score([{ name: 'stacked frames', ...stackedFramesBoard() }], layoutStraight)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 1,
      // 2618/1860 (1.408), worst 1.69 before the corner detours.
      length: 1899,
      direct: 1580,
      ratio: 1.202,
      worstRatio: 1.4,
      longDetours: 0,
      bends: 6,
      crossings: 3,
      borderInk: 0,
    })
  })

  it('reports generated stacked-frame boards', { timeout: 120_000 }, () => {
    expect(score(stackedFrameLayouts(200), layoutStraight)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 80,
      // ratio 1.194, worst 1.91, 66 long detours before.
      length: 270710,
      direct: 242226,
      ratio: 1.118,
      worstRatio: 1.58,
      longDetours: 6,
      bends: 786,
      crossings: 112,
      borderInk: 0,
    })
  })

  it('reports the synthetic corpus', { timeout: 180_000 }, () => {
    expect(score(syntheticLayouts(2000), routedOnly)).toEqual({
      violations: { foreign: 25, 'own-endpoint': 20 },
      interiorInk: 3494,
      titleCrossings: 0,
      // ratio 1.116, worst 11.63, 245 long detours before.
      length: 858236,
      direct: 800854,
      ratio: 1.072,
      worstRatio: 7.67,
      longDetours: 125,
      bends: 1896,
      crossings: 188,
      borderInk: 998,
    })
  })

  it('reports lattice boards', { timeout: 180_000 }, () => {
    expect(score(latticeLayouts(400), routedOnly)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 0,
      // ratio 1.068, worst 2.01, 26 long detours before.
      length: 1178375,
      direct: 1151990,
      ratio: 1.023,
      worstRatio: 1.53,
      longDetours: 3,
      bends: 1416,
      crossings: 590,
      borderInk: 0,
    })
  })
})
