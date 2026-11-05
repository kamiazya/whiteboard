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

describe('straight routing quality', () => {
  it('reports the stacked-frames board', () => {
    expect(score([{ name: 'stacked frames', ...stackedFramesBoard() }], layoutStraight)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 1,
      length: 2618,
      direct: 1860,
      ratio: 1.408,
      worstRatio: 1.69,
      longDetours: 1,
      bends: 8,
      crossings: 0,
      borderInk: 130,
    })
  })

  it('reports generated stacked-frame boards', { timeout: 120_000 }, () => {
    expect(score(stackedFrameLayouts(200), layoutStraight)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 114,
      length: 310565,
      direct: 260186,
      ratio: 1.194,
      worstRatio: 1.91,
      longDetours: 66,
      bends: 841,
      crossings: 76,
      borderInk: 6747,
    })
  })

  it('reports the synthetic corpus', { timeout: 180_000 }, () => {
    expect(score(syntheticLayouts(2000), routedOnly)).toEqual({
      violations: { foreign: 21, 'own-endpoint': 52 },
      interiorInk: 5763,
      titleCrossings: 0,
      length: 900823,
      direct: 807188,
      ratio: 1.116,
      worstRatio: 11.63,
      longDetours: 245,
      bends: 2104,
      crossings: 248,
      borderInk: 10530,
    })
  })

  it('reports lattice boards', { timeout: 180_000 }, () => {
    expect(score(latticeLayouts(400), routedOnly)).toEqual({
      violations: { foreign: 0, 'own-endpoint': 0 },
      interiorInk: 0,
      titleCrossings: 0,
      length: 1271906,
      direct: 1191073,
      ratio: 1.068,
      worstRatio: 2.01,
      longDetours: 26,
      bends: 1422,
      crossings: 724,
      borderInk: 10020,
    })
  })
})
