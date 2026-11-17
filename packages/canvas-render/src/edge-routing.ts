/**
 * The routing contract the Rust core answers (ADR-0054): which sides an
 * edge's ends settled on and where, what a gesture freezes of them, how one
 * edge's routing style is asked, and the account one layout's routing spends
 * from. The router itself is the core's; its TypeScript was deleted in step
 * 7 (S18h3b), so what stays here is only what a caller hands the core or
 * reads back from it.
 */

import type { EdgeSide } from '@kamiazya/whiteboard-model'
import type { Point } from './generated/geometry.zod.js'

/** A side pair for one edge: where it leaves and where it arrives. */
export interface EdgeSides {
  readonly fromSide: EdgeSide
  readonly toSide: EdgeSide
  /**
   * The side search stepped a straight edge round what was in its way, so it
   * is drawn by its corner route rather than as one segment.
   */
  readonly around?: true
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
   * crowded each side is across the WHOLE edge set, which one edge's route
   * does not know, so the pass records its choice and the route follows it.
   */
  readonly fromSide?: EdgeSide
  readonly toSide?: EdgeSide
  /** The side pass's `EdgeSides.around`, carried to the route the same way. */
  readonly around?: true
}

/**
 * A frozen edge's full anchor state, for overrides that must not MOVE
 * mid-gesture: sides alone leave the anchor a fraction of its (node, side)
 * group, so a carried edge joining the group re-fractions a stationary
 * edge. Point/depth fields, when present, pin the committed positions, and
 * `around` (inherited from the side pair) holds a straight edge the
 * committed search stepped round what was in its way: without it the edge
 * takes its corner route the moment it is frozen.
 */
export interface EdgeAnchorOverride extends EdgeSides {
  readonly from?: Point
  readonly fromLaneDepth?: number
  readonly to?: Point
  readonly toLaneDepth?: number
}

/**
 * What one layout may spend on the parts of edge routing whose cost grows
 * faster than the board: the grid router, the side-choice search's
 * segment-pair scoring and the rest of what each of its trials repeats, and
 * the coincident-ends repair. Past an account each search keeps the answer
 * it falls back to anyway; below it nothing changes. The core spends from it
 * and writes back what is left.
 */
export interface RoutingBudget {
  /**
   * Obstacle tests the grid router may still make: one obstacle against one
   * grid line while bucketing, one bucketed obstacle per search step.
   */
  grid: number
  /** Segment pairs the side-choice search may still examine, built or re-scored. */
  pairs: number
  /** Visits the side-choice search's trials may still make outside the segment pairs. */
  trials: number
  /** Visits the coincident-ends repair may still make. */
  repairs: number
}

/**
 * Sized against the largest boards in the suite and the benches, at about
 * four times what the busiest of them spends: a 2000-node, 1837-edge
 * clustered board makes 1.4e7 grid tests in one layout, and a 2000-node,
 * 2000-edge grid board 6e6 pair tests. The same clustered board spends 5.2e7
 * trial visits over its eighteen searches, the grid board 2.9e7. The repair
 * account is the exception to four times, because almost nothing spends it:
 * no board in the suite repairs for more than 3e4 visits, and a million is a
 * second at worst. The core holds the same numbers for a layout it is handed
 * no budget for.
 */
const LAYOUT_GRID_TESTS = 64_000_000
const LAYOUT_SEGMENT_PAIRS = 64_000_000
const LAYOUT_TRIAL_VISITS = 200_000_000
const LAYOUT_REPAIR_VISITS = 1_000_000

/**
 * The running account for ONE layout. A counter rather than a value threaded
 * functionally, because every route and every trial in the layout spends from
 * the same pool and none of them returns anything to hand the rest back.
 */
export function createRoutingBudget(): RoutingBudget {
  return {
    grid: LAYOUT_GRID_TESTS,
    pairs: LAYOUT_SEGMENT_PAIRS,
    trials: LAYOUT_TRIAL_VISITS,
    repairs: LAYOUT_REPAIR_VISITS,
  }
}
