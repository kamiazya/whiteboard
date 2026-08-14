// The one invariant every reported routing defect violated: a line drawn
// through the inside of a box. Four of them (#705, #706, #711, #713) reached
// a human before they reached the suite, because each was pinned by the
// single canvas that exposed it and nothing asked the question generally.
//
// The exemption is the one `routeEdge` already applies when it picks
// obstacles: a rect that STRICTLY contains an anchor can never be routed
// around, since every detour still has to reach the point inside it — that is
// what lets an edge between two members of a group run inside the group's
// frame. A rect merely touched by an anchor on its border, INCLUDING the
// edge's own two endpoints, is not exempt. That distinction is the whole
// point: `routeEdge` drops both endpoint nodes from its obstacle list, so a
// route through its own target's body is invisible to the search that picks
// it, and only the side-choice penalties upstream ever priced it.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { ROUTING_CORPUS, syntheticLayouts } from '../test-utils/routing-corpus.js'
import {
  bends,
  borderInk,
  crossings,
  drawnLength,
  finalSegmentLength,
  interiorInk,
  type MetricRect,
  pathLength,
} from '../test-utils/routing-metrics.js'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

type Violation = { edge: string; node: string; ink: number; kind: ViolationKind }

/**
 * Which search was supposed to prevent it. `own-endpoint` and `degenerate`
 * are invisible to `bestCandidate` by construction; `foreign` is a path
 * `pathIsClear` rejected but `bestCandidate` returned anyway, because its
 * last fallback takes the shortest BLOCKED candidate when none of its six
 * is clear.
 */
type ViolationKind = 'own-endpoint' | 'foreign' | 'degenerate'

const rectOf = (n: SpatialNode): MetricRect => ({ x: n.x, y: n.y, w: n.width, h: n.height })

const strictlyInside = (r: MetricRect, p: { x: number; y: number }) =>
  p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h

/** Every node body an edge put ink inside that it could have gone around. */
function avoidableInk(nodes: readonly SpatialNode[], edges: readonly CanvasEdge[]): Violation[] {
  const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
  const found: Violation[] = []
  for (const edge of edges) {
    const { path } = routeEdge(nodes, edge, 'orthogonal', anchors.get(edge.id))
    const start = path[0]
    const end = path[path.length - 1]
    if (start === undefined || end === undefined) continue
    const coincident = start.x === end.x && start.y === end.y
    for (const n of nodes) {
      const rect = rectOf(n)
      if (strictlyInside(rect, start) || strictlyInside(rect, end)) continue
      const ink = interiorInk(path, rect)
      if (ink <= 0) continue
      const own = n.id === edge.fromNode || n.id === edge.toNode
      found.push({
        edge: edge.id,
        node: n.id,
        ink,
        kind: coincident ? 'degenerate' : own ? 'own-endpoint' : 'foreign',
      })
    }
  }
  return found
}

/**
 * The arrowhead's own length. An edge whose final segment is shorter paints
 * an arrow with no line under it.
 */
const ARROW_LENGTH_PX = 10

describe('an edge is always visible', () => {
  // The strictest thing the corpus can say, and it is true today, so it is a
  // hard invariant rather than a counted debt: an edge someone drew must
  // never render as nothing. A zero-length path paints no line AND cannot
  // orient an arrowhead, so a reader cannot tell the edge exists — which is
  // indistinguishable from the canvas having lost it.
  //
  // This exists because a fix for a degenerate case very nearly shipped that
  // way: two boxes touching exactly put both anchors on one point, and
  // collapsing the route to that point removed the wrong drawing by removing
  // the drawing.
  // A deliberate sweep over the whole corpus, like the aggregate below: it
  // routes every edge of 2005 layouts, so it needs a budget that reflects
  // the work rather than the 5s default a unit test gets.
  it('draws something for every edge in every layout', { timeout: 60_000 }, () => {
    const invisible: { layout: string; edge: string }[] = []
    for (const testCase of [...ROUTING_CORPUS, ...syntheticLayouts(2000)]) {
      const anchors = assignEdgeAnchors(testCase.nodes, testCase.edges, 'orthogonal')
      for (const edge of testCase.edges) {
        const { path } = routeEdge(testCase.nodes, edge, 'orthogonal', anchors.get(edge.id))
        if (drawnLength(path) === 0) invisible.push({ layout: testCase.name, edge: edge.id })
      }
    }
    expect(invisible).toEqual([])
  })
})

describe('routing quality', () => {
  it.each(
    ROUTING_CORPUS.map((c) => [c.name, c] as const),
  )('draws no line through a node body — %s', (_name, testCase) => {
    expect(avoidableInk(testCase.nodes, testCase.edges)).toEqual([])
  })
})

/**
 * The aggregate the individual pins could never give: how often the router
 * draws through a box across many layouts, split by which search failed to
 * stop it, plus what the drawing costs.
 *
 * Two kinds of number, read differently:
 *
 * - `violations` and `interiorInk` are DEBT. The target is zero, and
 *   reaching it turns this into the strict property the corpus above
 *   already holds to. `own-endpoint` dominating by an order of magnitude is
 *   what says where to start — it is exactly the class `bestCandidate`
 *   cannot see.
 * - `borderInk`, `bends`, `crossings` and `length` are PRICE. They have no
 *   target; they are here so a change that buys less tunnelling with a
 *   worse-looking drawing cannot do it silently. A fix that halves interior
 *   ink and doubles the bend count is a trade someone has to accept out
 *   loud, not a win.
 *
 * Everything is pinned EXACTLY, not as a ceiling, so an improvement is as
 * loud as a regression: the point of a scoreboard is that the number moves
 * and someone has to say why. It is not a golden to regenerate.
 */
describe('routing quality across the synthetic corpus', () => {
  // A deliberate 2000-layout sweep, not a unit test: it routes tens of
  // thousands of edges and the default 5s timeout is close enough to its
  // runtime to fail under a loaded parallel suite rather than on merit.
  it('reports the current violation count and drawing cost', { timeout: 60_000 }, () => {
    const violations: Record<ViolationKind, number> = {
      'own-endpoint': 0,
      foreign: 0,
      degenerate: 0,
    }
    let interior = 0
    let border = 0
    let bendCount = 0
    let crossingCount = 0
    let length = 0
    // Arrowheads drawn on a segment shorter than the arrow itself.
    let shortRunway = 0
    for (const testCase of syntheticLayouts(2000)) {
      for (const v of avoidableInk(testCase.nodes, testCase.edges)) {
        violations[v.kind]++
        interior += v.ink
      }
      const anchors = assignEdgeAnchors(testCase.nodes, testCase.edges, 'orthogonal')
      const paths = testCase.edges.map(
        (edge) => routeEdge(testCase.nodes, edge, 'orthogonal', anchors.get(edge.id)).path,
      )
      crossingCount += crossings(paths)
      for (const path of paths) {
        bendCount += bends(path)
        length += pathLength(path)
        if (finalSegmentLength(path) < ARROW_LENGTH_PX) shortRunway++
        for (const n of testCase.nodes) border += borderInk(path, rectOf(n))
      }
    }
    expect({
      violations,
      interiorInk: Math.round(interior),
      borderInk: Math.round(border),
      bends: bendCount,
      crossings: crossingCount,
      length: Math.round(length),
      shortArrowRunway: shortRunway,
    }).toEqual({
      violations: { 'own-endpoint': 35, foreign: 17, degenerate: 0 },
      interiorInk: 3545,
      borderInk: 1056,
      bends: 8452,
      crossings: 636,
      length: 1358532,
      shortArrowRunway: 212,
    })
  })
})
