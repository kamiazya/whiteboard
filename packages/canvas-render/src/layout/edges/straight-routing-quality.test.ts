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
  let grazingEnds = 0
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
      const fromNode = testCase.nodes.find((n) => n.id === endNode(edge.from))
      const toNode = testCase.nodes.find((n) => n.id === endNode(edge.to))
      const second = path[1]
      const penultimate = path[path.length - 2]
      if (fromNode && second && grazes(start, second, rectOf(fromNode))) grazingEnds++
      if (toNode && penultimate && grazes(end, penultimate, rectOf(toNode))) grazingEnds++
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
    grazingEnds,
    bends: bendCount,
    crossings: crossingCount,
    borderInk: Math.round(border),
  }
}

const routedOnly = (testCase: RoutingCase) => ({ paths: routeStraight(testCase), titles: [] })

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
//   interior ink 5763 -> 3446. Each new foreign one crosses a box the router
//   never saw: one touched on its border by an anchor is dropped from the
//   obstacles, and the side search, seeing different routes, now settles on
//   anchors that touch it.
// - `grazingEnds` 2/111/374/209 -> 1/110/119/0 (persona, generated,
//   synthetic, lattice). The corner paths alone made it 5/386/167/118 — a
//   leg on from a corner beside the target can arrive nearly along its
//   side — which is what the stubs are for; they cost bends (persona
//   8 -> 9, lattice 1422 -> 1434, generated 841 -> 864).
// - `titleCrossings` 114 -> 82 on the generated boards and still 1 on the
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
      length: 2074,
      direct: 1683,
      ratio: 1.232,
      worstRatio: 1.42,
      longDetours: 0,
      grazingEnds: 1,
      bends: 9,
      crossings: 3,
      borderInk: 0,
    })
  })

  it('reports generated stacked-frame boards', { timeout: 120_000 }, () => {
    expect(score(stackedFrameLayouts(200), layoutStraight)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 82,
      // ratio 1.194, worst 1.91, 66 long detours before.
      length: 273505,
      direct: 248787,
      ratio: 1.099,
      worstRatio: 1.58,
      longDetours: 5,
      grazingEnds: 110,
      bends: 864,
      crossings: 107,
      borderInk: 0,
    })
  })

  it('reports the synthetic corpus', { timeout: 180_000 }, () => {
    expect(score(syntheticLayouts(2000), routedOnly)).toEqual({
      violations: { foreign: 25, 'own-endpoint': 20 },
      interiorInk: 3446,
      titleCrossings: 0,
      // ratio 1.116, worst 11.63, 245 long detours before.
      length: 858299,
      direct: 801178,
      ratio: 1.071,
      worstRatio: 7.67,
      longDetours: 130,
      grazingEnds: 119,
      bends: 1902,
      crossings: 187,
      borderInk: 879,
    })
  })

  it('reports lattice boards', { timeout: 180_000 }, () => {
    expect(score(latticeLayouts(400), routedOnly)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 0,
      // ratio 1.068, worst 2.01, 26 long detours before.
      length: 1176854,
      direct: 1150196,
      ratio: 1.023,
      worstRatio: 1.53,
      longDetours: 3,
      grazingEnds: 0,
      bends: 1434,
      crossings: 592,
      borderInk: 0,
    })
  })
})
