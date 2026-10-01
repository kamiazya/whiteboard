/**
 * The SIDE vocabulary of the edge layer: which of a node's four sides an
 * edge leaves from and arrives at, and how the first guess at that is made.
 * `EdgeSides` is the pair; `EdgeAnchorPair` is the pair once the anchor pass
 * has placed a point on each side; `EdgeAnchorOverride` is what an authored
 * facet pins. `rankedSidePairs` applies the named preference rules
 * (`edge-rules.ts`) to one edge, `initialSideChoices` to a whole canvas, and
 * the stub constants say how far an orthogonal edge leaves a side before it
 * may turn — the one number the anchor pass and the router both read.
 *
 * It sits below the anchor pass (`edge-anchors.ts`), the search
 * (`spatial-edges.ts`) and the router (`edge-router.ts`), and imports none
 * of them: a side is chosen before anything is placed or routed.
 */

import type { EdgeSide, SpatialNode } from '@kamiazya/whiteboard-model'
import { endNode, endSide, isSelfLoop, nodeAtEnd } from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import type { Point, Rect } from './edge-geometry.js'
import { centerOf, rectOf, sidePoint, strictlyInside } from './edge-geometry.js'
import { composeSidePairs, fullyContains, oppositeSide, type SidePair } from './edge-rules.js'

/**
 * Side preference for the FROM end, best first: the side facing the other
 * node on the dominant axis (the pre-existing default, so an unoccluded
 * canvas keeps its exact old sides), then the facing side of the other
 * axis, then their opposites. Ties (equal offsets) prefer the horizontal
 * axis — the same fixed tie-breaker the default derivation always had.
 */
type FacingSides = readonly [EdgeSide, EdgeSide, EdgeSide, EdgeSide]

function facingSides(dx: number, dy: number): FacingSides {
  const h: EdgeSide = dx >= 0 ? 'right' : 'left'
  const v: EdgeSide = dy >= 0 ? 'bottom' : 'top'
  return Math.abs(dx) >= Math.abs(dy)
    ? [h, v, oppositeSide(v), oppositeSide(h)]
    : [v, h, oppositeSide(h), oppositeSide(v)]
}

/**
 * Side-pair candidates ranked by ESTIMATED bends, best first — a thin
 * composer over the named PREFERENCE rules declared in edge-rules.ts
 * (decision #10 in package-canvas-render.md): a facing opposing pair whose
 * spans overlap routes as one straight segment (0 bends, dominant axis
 * first); a perpendicular L-pair reaches a genuinely diagonal target with
 * one bend; an opposing pair without a shared lane needs a two-bend Z; a
 * same-axis interpenetrating pair with no valid alternative falls back to
 * a U-hook. New routing feedback is one named rule + its own test in
 * edge-rules.ts, not a new branch here.
 */
export function rankedSidePairs(
  dx: number,
  dy: number,
  fromRect: Rect,
  toRect: Rect,
  crowd: (end: 'from' | 'to', side: EdgeSide) => number,
): readonly SidePair[] {
  return composeSidePairs({ dx, dy, fromRect, toRect, crowd })
}

/**
 * Deterministic default-side derivation for an edge with no explicit
 * fromSide/toSide, occlusion-aware: the preferred side is the pre-existing
 * center-offset derivation, but a side whose midpoint anchor sits strictly
 * INSIDE another node is skipped for the first exposed one. The endpoint
 * rects themselves are never obstacles (the edge has to reach them), so an
 * occluded anchor means the route legally cuts straight through the
 * occluding node — moving to an exposed side is what keeps it outside.
 *
 * Not occluders: the edge's other endpoint (entering the shared region IS
 * the edge's job), and any rect fully containing the endpoint node (a
 * group frame around its member occludes every side equally, which says
 * nothing about which side to prefer). With every side occluded the
 * derivation falls back to the preferred side, so fully-boxed-in nodes
 * keep the old behaviour.
 */
export function deriveDefaultSides(
  nodes: readonly SpatialNode[],
  edge: RoutableElement,
  fromRect: Rect,
  toRect: Rect,
  crowd: (end: 'from' | 'to', side: EdgeSide) => number = () => 0,
): SidePair {
  const fromCenter = centerOf(fromRect)
  const toCenter = centerOf(toRect)
  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y
  const pairs = rankedSidePairs(dx, dy, fromRect, toRect, crowd)
  // Hoisted: this filter runs once per node per routing call, and reading
  // the end twice per node is a call the loop does not need.
  const fromId = endNode(edge.from)
  const toId = endNode(edge.to)
  const foreign = nodes.filter((n) => n.id !== fromId && n.id !== toId).map(rectOf)
  const exposed = (rect: Rect, side: EdgeSide): boolean => {
    const occluders = foreign.filter((r) => !fullyContains(r, rect))
    return !occluders.some((r) => strictlyInside(r, sidePoint(rect, side)))
  }
  // Ranking is geometric only; occlusion then moves an end that is buried
  // under a neighbour to its next exposed side.
  const best = pairs[0]!
  const pick = (rect: Rect, primary: EdgeSide, mirror: FacingSides): EdgeSide => {
    const candidates = [primary, ...mirror.filter((sd) => sd !== primary)]
    return candidates.find((side) => exposed(rect, side)) ?? primary
  }
  const fromMirror = facingSides(dx, dy)
  const toMirror = fromMirror.map(oppositeSide) as unknown as FacingSides
  const fromSide = pick(fromRect, best.fromSide, fromMirror)
  // partner-follows-moved-end: an arrival is chosen as the partner of a
  // particular departure, so when occlusion moves the departure the arrival
  // is left describing a pair that no longer exists — `left->bottom` with
  // the departure pushed to `top` becomes `top->bottom`, a combination the
  // ranking never proposed and which reaches the target's far side the long
  // way round. The coherent partner is the one on the axis the departure did
  // NOT take: leaving horizontally arrives on the vertical facing side, and
  // leaving vertically arrives on the horizontal one. Only the orphaned half
  // is replaced — an arrival occlusion never touched keeps its own choice.
  const horizontal = (side: EdgeSide) => side === 'left' || side === 'right'
  const h: EdgeSide = dx >= 0 ? 'right' : 'left'
  const v: EdgeSide = dy >= 0 ? 'bottom' : 'top'
  const partnerSide =
    fromSide === best.fromSide ? best.toSide : oppositeSide(horizontal(fromSide) ? v : h)
  return { fromSide, toSide: pick(toRect, partnerSide, toMirror) }
}

/** Distance the self-edge loop bulges out along the selected side's outward normal, in px. */
const SELF_EDGE_LOOP_OFFSET_PX = 40
/** Half-width of the self-edge loop along the side perpendicular to the outward normal, in px. */
const SELF_EDGE_LOOP_SPREAD_PX = 20

/**
 * Two control points for a self-edge loop, offset outward from `start` along
 * `side`'s outward normal (not toward the node interior) and spread along the
 * perpendicular axis so the loop reads as a visible bulge rather than a
 * straight line back to itself.
 */
export function selfEdgeLoopControlPoints(start: Point, side: EdgeSide): [Point, Point] {
  switch (side) {
    case 'right':
      return [
        { x: start.x + SELF_EDGE_LOOP_OFFSET_PX, y: start.y - SELF_EDGE_LOOP_SPREAD_PX },
        { x: start.x + SELF_EDGE_LOOP_OFFSET_PX, y: start.y + SELF_EDGE_LOOP_SPREAD_PX },
      ]
    case 'left':
      return [
        { x: start.x - SELF_EDGE_LOOP_OFFSET_PX, y: start.y - SELF_EDGE_LOOP_SPREAD_PX },
        { x: start.x - SELF_EDGE_LOOP_OFFSET_PX, y: start.y + SELF_EDGE_LOOP_SPREAD_PX },
      ]
    case 'top':
      return [
        { x: start.x - SELF_EDGE_LOOP_SPREAD_PX, y: start.y - SELF_EDGE_LOOP_OFFSET_PX },
        { x: start.x + SELF_EDGE_LOOP_SPREAD_PX, y: start.y - SELF_EDGE_LOOP_OFFSET_PX },
      ]
    case 'bottom':
      return [
        { x: start.x - SELF_EDGE_LOOP_SPREAD_PX, y: start.y + SELF_EDGE_LOOP_OFFSET_PX },
        { x: start.x + SELF_EDGE_LOOP_SPREAD_PX, y: start.y + SELF_EDGE_LOOP_OFFSET_PX },
      ]
  }
}

/** An edge's resolved endpoint positions, when the fan-out pass moved them. */
export interface EdgeAnchorPair {
  readonly from?: Point
  readonly to?: Point
  /** Stub depth for each end, when its (node, side) group assigned a lane. */
  readonly fromLaneDepth?: number
  readonly toLaneDepth?: number
  /**
   * The sides the anchor pass resolved. Side choice can depend on how
   * crowded each side is across the WHOLE edge set — information a single
   * routeEdge call does not have — so the pass records its choice and
   * routeEdge follows it, keeping the two producers agreeing.
   */
  readonly fromSide?: EdgeSide
  readonly toSide?: EdgeSide
}

/**
 * Deterministic anchor positions for every edge end, spreading the ends
 * that share one (node, side) instead of stacking them all on the side's
 * midpoint. JSON Canvas authors a side but never a position along it, so
 * the position is the renderer's to choose — and a stack of ends at one
 * point makes edges with different colors or arrowheads read as a single
 * line until they diverge.
 *
 * Within a shared side, ends sit at fractions 1/(n+1) … n/(n+1), ordered
 * by where the FAR endpoint's center lies along the side's tangent axis so
 * routes leave in the order of their destinations and never cross right at
 * the node; ties (same far node, e.g. a bidirectional pair) fall back to
 * edge document order, then from-before-to. A side with a single end keeps
 * its midpoint, so documents without shared sides render exactly as before.
 *
 * Edges with a missing endpoint get no entry — `routeEdge` already
 * degrades those to a zero-length path on its own.
 */
/** A resolved side pair for one edge, as consumed by `edgeSideOverrides`. */
export type EdgeSides = SidePair

/**
 * A frozen edge's full anchor state, for overrides that must not MOVE
 * mid-gesture: sides alone leave the anchor a fraction of its (node, side)
 * group, so a carried edge joining the group re-fractions a stationary
 * edge. Point/depth fields, when present, pin the committed positions.
 */
export interface EdgeAnchorOverride extends EdgeSides {
  readonly from?: Point
  readonly fromLaneDepth?: number
  readonly to?: Point
  readonly toLaneDepth?: number
}

/**
 * A crowding estimate per (node, side), plus the prospective side pair each
 * edge contributed to it.
 *
 * The prospective side is the AUTHORED one, or the plain dominant-axis
 * facing side — deliberately NOT the crowd-aware derivation, which would
 * recurse. That is what lets a departure prefer a side other edges have not
 * already claimed, deterministically and independent of edge order.
 */
function prospectiveSideCrowding(
  edges: readonly RoutableElement[],
  byId: ReadonlyMap<string, SpatialNode>,
): { crowdCounts: Map<string, number>; prospective: Map<string, SidePair> } {
  const crowdCounts = new Map<string, number>()
  const prospective = new Map<string, SidePair>()
  for (const edge of edges) {
    const fromNode = nodeAtEnd(edge.from, byId)
    const toNode = nodeAtEnd(edge.to, byId)
    if (fromNode === undefined || toNode === undefined) continue
    if (isSelfLoop(edge)) continue
    const fromCenter = centerOf(rectOf(fromNode))
    const toCenter = centerOf(rectOf(toNode))
    const primary = facingSides(toCenter.x - fromCenter.x, toCenter.y - fromCenter.y)[0]
    const sides = {
      fromSide: endSide(edge.from) ?? primary,
      toSide: endSide(edge.to) ?? oppositeSide(primary),
    }
    prospective.set(edge.id, sides)
    for (const key of [
      `${endNode(edge.from)} ${sides.fromSide}`,
      `${endNode(edge.to)} ${sides.toSide}`,
    ]) {
      crowdCounts.set(key, (crowdCounts.get(key) ?? 0) + 1)
    }
  }
  return { crowdCounts, prospective }
}

/**
 * The heuristic side choice per edge — authored sides applied, self-edges
 * pinned to their loop side, crowd-aware pair ranking for the rest. This
 * is the INITIAL configuration; `optimizeSideChoices` may re-side edges
 * whose guesses produce crossings or overlaps.
 */
export function initialSideChoices(
  nodes: readonly SpatialNode[],
  edges: readonly RoutableElement[],
): Map<string, SidePair> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // Crowding estimate per (node, side): every edge end's PROSPECTIVE side
  // (authored, or the plain dominant-axis facing side — deliberately NOT
  // the crowd-aware derivation, which would recurse) — so a departure can
  // prefer a side other edges have not already claimed, deterministically
  // and independent of edge order.
  const { crowdCounts, prospective } = prospectiveSideCrowding(edges, byId)
  const choices = new Map<string, SidePair>()
  for (const edge of edges) {
    const fromNode = nodeAtEnd(edge.from, byId)
    const toNode = nodeAtEnd(edge.to, byId)
    if (fromNode === undefined || toNode === undefined) continue
    const fromRect = rectOf(fromNode)
    const toRect = rectOf(toNode)
    const own = prospective.get(edge.id)
    const crowd = (end: 'from' | 'to', side: EdgeSide): number => {
      const nodeId = end === 'from' ? endNode(edge.from) : endNode(edge.to)
      const ownSide = end === 'from' ? own?.fromSide : own?.toSide
      const count = crowdCounts.get(`${nodeId} ${side}`) ?? 0
      return ownSide === side ? count - 1 : count
    }
    const derived = isSelfLoop(edge)
      ? { fromSide: 'right' as EdgeSide, toSide: 'right' as EdgeSide }
      : deriveDefaultSides(nodes, edge, fromRect, toRect, crowd)
    choices.set(edge.id, {
      fromSide: endSide(edge.from) ?? derived.fromSide,
      toSide: endSide(edge.to) ?? derived.toSide,
    })
  }
  return choices
}

/** How far an orthogonal edge travels straight out of a node before turning. */
export const ORTHOGONAL_STUB_PX = 20
/** Extra stub depth per additional member of a shared (node, side) group,
 * so ends sharing a side leave through parallel DISTINCT corridors instead
 * of one collinear overlap that a line jump cannot express. One-sided and
 * strictly additive: lane 0 keeps the exact base depth (unshared documents
 * are byte-identical), deeper lanes only ever move AWAY from their node.
 * ponytail: depth grows unbounded with group size — a ~15-edge side pushes
 * the deepest stub ~200px out; cap distinct lanes and share the outermost
 * if that ever hurts. */
export const STUB_LANE_STEP_PX = 12
