// The one invariant every reported routing defect violated: a line drawn
// through the inside of a box. Pinning each such defect to the single canvas
// that exposed it left the next one to reach a human first, because nothing
// asked the question generally.
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
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { endNode } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import {
  clusteredLayout,
  designerBoard,
  latticeLayouts,
  ROUTING_CORPUS,
  syntheticLayouts,
} from '../../test-utils/routing-corpus.js'
import {
  bends,
  borderInk,
  crossings,
  drawnLength,
  finalSegmentLength,
  interiorInk,
  type MetricRect,
  pathLength,
  touches,
  unhoppedCrossings,
} from '../../test-utils/routing-metrics.js'
import { computeEdgeJumps } from './edge-jumps.js'
import { routeEdge } from './edge-router.js'
import { assignEdgeAnchors } from './spatial-edges.js'

type Violation = { edge: string; node: string; ink: number; kind: ViolationKind }

/**
 * Which search was supposed to prevent it. `own-endpoint` and `degenerate`
 * are invisible to `bestCandidate` by construction; `foreign` is a path
 * `pathIsClear` rejected but `bestCandidate` returned anyway, because its
 * last fallback takes the shortest BLOCKED candidate when none of its six
 * is clear.
 */
type ViolationKind = 'own-endpoint' | 'foreign' | 'degenerate'

/** Every edge routed as the layout would route it, anchors assigned together. */
function routeAll(nodes: readonly SpatialNode[], edges: readonly CanvasEdge[]) {
  const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
  return edges.map((edge) => routeEdge(nodes, edge, 'orthogonal', anchors.get(edge.id)))
}

/** Crossings of these routed edges that line jumps leave undrawn. */
function undrawnHops(routed: readonly ResolvedEdgeNode[]): number {
  const jumps = computeEdgeJumps(routed)
  return unhoppedCrossings(
    routed.map((r) => r.path),
    routed.map((r) => (jumps.get(r.id) ?? []).map((j) => ({ x: j.x, y: j.y }))),
  )
}

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
      const own = n.id === endNode(edge.from) || n.id === endNode(edge.to)
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
  it('draws something for every edge in every layout', { timeout: 180_000 }, () => {
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
 * - `touches` and `unhoppedCrossings` are DEBT too: two edges meeting at a
 *   corner draw a plus sign that neither a crossing count nor a hop can
 *   see, and a crossing too near a segment end draws no hop even when line
 *   jumps are on. Read from the hops `computeEdgeJumps` actually emits, against
 *   crossings found between straight runs rather than between waypoints.
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
  it('reports the current violation count and drawing cost', { timeout: 180_000 }, () => {
    const violations: Record<ViolationKind, number> = {
      'own-endpoint': 0,
      foreign: 0,
      degenerate: 0,
    }
    let interior = 0
    let border = 0
    let bendCount = 0
    let crossingCount = 0
    let touchCount = 0
    let unhopped = 0
    let length = 0
    // Arrowheads drawn on a segment shorter than the arrow itself.
    let shortRunway = 0
    for (const testCase of syntheticLayouts(2000)) {
      for (const v of avoidableInk(testCase.nodes, testCase.edges)) {
        violations[v.kind]++
        interior += v.ink
      }
      const routed = routeAll(testCase.nodes, testCase.edges)
      const paths = routed.map((r) => r.path)
      crossingCount += crossings(paths)
      touchCount += touches(paths)
      unhopped += undrawnHops(routed)
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
      touches: touchCount,
      unhoppedCrossings: unhopped,
      length: Math.round(length),
      shortArrowRunway: shortRunway,
    }).toEqual({
      // 12/15/2083 -> 10/7/955 when a lone edge started reaching the
      // search: the optimizer was gated at two edges, so a single-edge
      // layout kept whatever the initial ranking picked, foreign body and
      // all. Every price column moved down with it (bends 8152 -> 8046,
      // border ink 824 -> 770, length 1341164 -> 1338795); crossings and
      // short runways did not move.
      //
      // When touching boxes started being drawn as their contact mark (one
      // arrowhead's run ending on the shared border) rather than routed
      // round: own-endpoint/foreign 10/7 -> 11/5, bends 8046 -> 5087,
      // crossings 494 -> 352, touches 36 -> 13, length 1338795 -> 1164519,
      // border ink 770 -> 487. Interior ink 955 -> 999 and short runways
      // 136 -> 167 are the marks themselves: each spends its arrowhead inside
      // the source, and is one arrowhead long by design.
      violations: { 'own-endpoint': 11, foreign: 5, degenerate: 0 },
      interiorInk: 999,
      borderInk: 487,
      bends: 5087,
      crossings: 352,
      touches: 13,
      // 54 -> 22 when a crossing on a waypoint of a straight run started to
      // hop (the earlier line hops when the later one has no room); 22 -> 9
      // with the contact marks above.
      unhoppedCrossings: 9,
      length: 1164519,
      shortArrowRunway: 167,
    })
  })
})

// The corpus above is 2000 SMALL layouts, every one of them under the
// side-choice optimizer's edge gate. Nothing in this file has ever asked
// what a canvas past that gate looks like — and past it the optimizer is
// skipped wholesale, so the answer is "whatever the initial ranking
// happened to pick". An AI-authored document reaches this size easily, and
// the debt below is what it is served today.
//
// Pinned exactly, like the aggregate above, and for the same reason: this
// is a debt figure whose target is lower, and an improvement has to be as
// loud as a regression.
//
// One movement in these numbers is NOT a routing change and is worth knowing
// before chasing it: `routeOnGrid` searches with A*, which expands fewer
// states than the Dijkstra it replaced and therefore settles on a different
// member of the set of EQUAL-cost shortest paths. Measured over 7419
// generated cases the two never disagreed about what an optimal route costs
// and disagreed about which one to draw in 10-30% of them, and on this canvas
// exactly 2 of 345 edges then settled on different sides. That is what moved
// violations 99 -> 100 and interior ink 11451 -> 11578 here. The grid search
// avoids every obstacle interior including the edge's own endpoints, so its
// path cannot itself be a violation — the difference arrives through the
// side-choice search, which no per-edge routing cost can see or target. Two
// attempts to recover it (a lower-g heap tie-break, then a canonical
// predecessor) were measured and neither moved it.
describe('routing quality past the side-choice optimizer gate', () => {
  it('reports the drawing cost of a large clustered canvas', () => {
    const layout = clusteredLayout({ clusters: 24, nodesPerCluster: 12, edgesPerCluster: 16 })
    const violations = avoidableInk(layout.nodes, layout.edges)
    const anchors = assignEdgeAnchors(layout.nodes, layout.edges, 'orthogonal')
    const paths = layout.edges.map(
      (edge) => routeEdge(layout.nodes, edge, 'orthogonal', anchors.get(edge.id)).path,
    )
    let bendCount = 0
    let length = 0
    let border = 0
    for (const path of paths) {
      bendCount += bends(path)
      length += drawnLength(path)
      for (const n of layout.nodes) border += borderInk(path, rectOf(n))
    }
    expect({
      edges: layout.edges.length,
      violations: violations.length,
      interiorInk: Math.round(violations.reduce((sum, v) => sum + v.ink, 0)),
      borderInk: Math.round(border),
      bends: bendCount,
      crossings: crossings(paths),
      length: Math.round(length),
    }).toEqual({
      // 100/11578/266/760/855/275766 before touching pairs were drawn as
      // their contact mark. The 35 marks carry no border ink of their own;
      // border ink 266 -> 506 is the routed edges, re-sided by a search that
      // no longer counts the marks, and every other column fell.
      edges: 345,
      violations: 93,
      interiorInk: 11006,
      borderInk: 506,
      bends: 664,
      crossings: 819,
      length: 269387,
    })
  }, 120_000)
})

/**
 * The board a designer drew: eight boxes in two frames, orthogonal routing,
 * line jumps on. Its debts are the ones a reader sees, not the ones the
 * synthetic sweep prices: an edge that reads as connecting a box it only
 * passes, and two edges meeting at a corner so that they draw a plus sign
 * no hop can break.
 */
describe('routing quality on the service-tier board', () => {
  const board = designerBoard()
  const routed = routeAll(board.nodes, board.edges)
  const paths = routed.map((r) => r.path)

  it('reports its debt', () => {
    const throughUnrelated = new Set(
      avoidableInk(board.nodes, board.edges)
        .filter((v) => v.kind === 'foreign')
        .map((v) => v.edge),
    )
    expect({
      edgesThroughUnrelatedNode: throughUnrelated.size,
      touches: touches(paths),
      unhoppedCrossings: undrawnHops(routed),
      crossings: crossings(paths),
    }).toEqual({
      // 0/1/0/0 -> 0/0/0/1 when two corners on one point were priced as the
      // crossing they read as: the Gateway -> Queue detour left the margin
      // lane it shared with Auth -> Orders and runs under the Gateway, where
      // the crossing it now makes is hopped.
      edgesThroughUnrelatedNode: 0,
      touches: 0,
      unhoppedCrossings: 0,
      crossings: 1,
    })
  })
})

/**
 * The same columns over boxes on a lattice, where lanes coincide. Measured
 * apart from the synthetic corpus so neither number hides the other: a fix
 * for aligned boards can leave the scattered ones byte-identical.
 */
describe('routing quality across lattice boards', () => {
  it('reports the current violation count and drawing cost', { timeout: 180_000 }, () => {
    let throughUnrelated = 0
    let touchCount = 0
    let unhopped = 0
    let crossingCount = 0
    let bendCount = 0
    let length = 0
    for (const testCase of latticeLayouts(400)) {
      throughUnrelated += new Set(
        avoidableInk(testCase.nodes, testCase.edges)
          .filter((v) => v.kind === 'foreign')
          .map((v) => v.edge),
      ).size
      const routed = routeAll(testCase.nodes, testCase.edges)
      const paths = routed.map((r) => r.path)
      touchCount += touches(paths)
      unhopped += undrawnHops(routed)
      crossingCount += crossings(paths)
      for (const path of paths) {
        bendCount += bends(path)
        length += pathLength(path)
      }
    }
    expect({
      edgesThroughUnrelatedNode: throughUnrelated,
      touches: touchCount,
      unhoppedCrossings: unhopped,
      crossings: crossingCount,
      bends: bendCount,
      length: Math.round(length),
    }).toEqual({
      // touches 100 -> 94, crossings 320 -> 323, bends 3282 -> 3286, length
      // 1488552 -> 1488498: six corner kisses became crossings, of which a
      // reader sees three more and a hop can now break; the other 94 touches
      // are crossings that land on a collinear waypoint of one path.
      edgesThroughUnrelatedNode: 0,
      touches: 94,
      // 96 -> 2 likewise.
      unhoppedCrossings: 2,
      crossings: 323,
      bends: 3286,
      length: 1488498,
    })
  })
})
