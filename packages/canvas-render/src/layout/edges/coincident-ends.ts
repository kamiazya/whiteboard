/**
 * How the side search's last step scores a side pair for an edge whose two
 * anchors landed on one point — a member flush with the border of the box
 * holding it — so the repair (`anchorsWithoutCoincidentEnds`) re-sides it
 * onto the pair that routes best and no connection is drawn as a dot.
 */

import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { endSide } from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import { hypot } from '../../det-math.js'
import type { AnchorContext, AnchorGroups } from './edge-anchors.js'
import { computeAnchorsFor, patchAnchorGroups, patchWork } from './edge-anchors.js'
import type { Point, Rect } from './edge-geometry.js'
import { pathLength } from './edge-geometry.js'
import { routeEdge } from './edge-router.js'
import { bendCount, interiorInkThrough, type SidePair } from './edge-rules.js'
import type { EdgeAnchorOverride, EdgeAnchorPair, EdgeStyleOf } from './edge-sides.js'
import type { RoutingBudget } from './routing-budget.js'
import { spend } from './routing-budget.js'

/** An arrowhead's own length: a final segment shorter than this paints an
 * arrow with no line under it (see edge-arrows.ts's ARROW_LENGTH). */
const ARROW_RUNWAY_PX = 10

interface RepairScore {
  pair: SidePair
  tier: number
  bends: number
  length: number
}

/**
 * The best side pair among `candidates` for a collided edge, or `undefined`
 * when none reaches it at all.
 *
 * EVERY candidate is scored, not just the first that qualifies: two
 * predicates are needed and neither alone is enough — "not coincident" alone
 * accepted a pair that reached the far side straight THROUGH the target, and
 * "first clean one" alone accepted a four-bend loop around both boxes when a
 * short hop up the shared side was available. Clean is the requirement;
 * shortest-and-straightest picks among the clean.
 *
 * Three TIERS, because they are not equally important and treating them as
 * one filter made an edge vanish: clean with runway is best, clean without
 * runway still beats an ugly route, and ANY visible route beats the collided
 * pair. Visibility is the requirement; the rest is preference.
 */
export function bestRepairedPair(
  candidates: readonly SidePair[],
  ctx: {
    edge: RoutableElement
    edgeIndex: number
    nodes: readonly SpatialNode[]
    labels: readonly Rect[]
    ctx: AnchorContext
    repaired: ReadonlyMap<string, SidePair>
    placement: AnchorGroups
    align: boolean
    pins: ReadonlyMap<string, EdgeAnchorOverride> | undefined
    styleOf: EdgeStyleOf
    fromRect: Rect
    toRect: Rect
    coincides: (anchors: ReadonlyMap<string, EdgeAnchorPair>, id: string) => boolean
    budget: RoutingBudget
  },
): (RepairScore & { placement: AnchorGroups }) | 'exhausted' | undefined {
  const { edge, edgeIndex, nodes, labels, repaired, placement, align, pins, styleOf } = ctx
  const { fromRect, toRect, coincides, budget } = ctx
  let best: (RepairScore & { placement: AnchorGroups }) | undefined
  for (const pair of candidates) {
    const sided: SidePair = {
      fromSide: endSide(edge.from) ?? pair.fromSide,
      toSide: endSide(edge.to) ?? pair.toSide,
    }
    const trial = new Map(repaired)
    trial.set(edge.id, sided)
    // Patched, not rebuilt: where every edge collided one side holds them all.
    const work = patchWork(ctx.ctx, placement, trial, edgeIndex) + ctx.ctx.edges.length
    if (!spend(budget, 'repairs', work + nodes.length)) return 'exhausted'
    const trialPlacement = patchAnchorGroups(ctx.ctx, placement, trial, edgeIndex)
    const trialAnchors = computeAnchorsFor(ctx.ctx, trial, align, pins, trialPlacement)
    if (coincides(trialAnchors, edge.id)) continue
    const anchors = trialAnchors.get(edge.id)
    const { path } = routeEdge(nodes, edge, styleOf(edge), anchors, undefined, budget, labels)
    const scored = scoreRepairedRoute(sided, path, fromRect, toRect)
    if (best === undefined || betterRepair(scored, best)) {
      best = { ...scored, placement: trialPlacement }
    }
  }
  return best
}

/**
 * One candidate route's tier, bends and length.
 *
 * The arrowhead is drawn ON the final segment, so a route that arrives with
 * no runway paints an arrow with no line under it. Re-siding is choosing
 * this route from scratch, so it can decline those.
 */
function scoreRepairedRoute(
  pair: SidePair,
  path: readonly Point[],
  fromRect: Rect,
  toRect: Rect,
): RepairScore {
  const tail = path[path.length - 1]
  const beforeTail = path[path.length - 2]
  const runway =
    tail === undefined || beforeTail === undefined
      ? 0
      : hypot(tail.x - beforeTail.x, tail.y - beforeTail.y)
  const clean = interiorInkThrough(path, [fromRect, toRect]) === 0
  return {
    pair,
    tier: clean && runway >= ARROW_RUNWAY_PX ? 0 : clean ? 1 : 2,
    bends: bendCount(path),
    length: pathLength(path),
  }
}

/** Tier first, then fewer bends, then shorter. */
function betterRepair(a: RepairScore, b: RepairScore): boolean {
  if (a.tier !== b.tier) return a.tier < b.tier
  if (a.bends !== b.bends) return a.bends < b.bends
  return a.length < b.length
}
