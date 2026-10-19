/**
 * What one layout may spend on the parts of edge routing whose cost grows
 * faster than the board: the grid router (`grid-route.ts`), the side-choice
 * search's segment-pair scoring and the rest of what each of its trials
 * repeats, and the coincident-ends repair (`spatial-edges.ts`).
 *
 * The grid and the search are bounded per CALL by something else — the grid
 * by its cell cap, the search by its edge gate and trial budget — and
 * neither bound sees the term that actually grows. A grid call buckets every obstacle in its window
 * against every grid line, and copies of one obstacle add obstacles without
 * adding a line or a cell. A trial re-scores every segment pair of the edges
 * it touched, and an edge drawn through its stored bends brings up to
 * MAX_BENDS + 1 segments to every pair. A board built for either stalls the
 * layout for minutes while staying inside every model ceiling.
 *
 * Past the budget each search keeps the answer it falls back to anyway: the
 * grid router returns nothing, so the enumerated candidate stands, the
 * side-choice search stops with the sides it has, a partial repair, and the
 * coincident-ends repair leaves the edges it has not reached on their
 * collided pair, drawn as the shared point. Below it nothing changes — every
 * check refuses only work the account cannot cover.
 */
export interface RoutingBudget {
  /**
   * Obstacle tests the grid router may still make: one obstacle against one
   * grid line while bucketing, one bucketed obstacle per search step.
   */
  grid: number
  /** Segment pairs the side-choice search may still examine, built or re-scored. */
  pairs: number
  /**
   * Visits the side-choice search's trials may still make outside the
   * segment pairs: an anchor-group member re-placed, a node passed while an
   * edge is re-routed or re-scored, an edge passed while its pairs are
   * looked up. A trial that re-sides one edge moves every end sharing a side
   * with it, so on a board that crowds one side a trial touches every edge,
   * and each touched edge pays for every node and every other edge again.
   */
  trials: number
  /**
   * Visits the coincident-ends repair may still make: per candidate side
   * pair of a collided edge, the anchor-group members it re-places, the
   * edges its anchor pass reads and the nodes its route passes.
   */
  repairs: number
}

/**
 * Sized against the largest boards in the suite and the benches, at about
 * four times what the busiest of them spends: a 2000-node, 1837-edge
 * clustered board makes 1.4e7 grid tests in one layout, and a 2000-node,
 * 2000-edge grid board 6e6 pair tests (3e6 on the 200-edge dense bench, in
 * one region). The same 2000-node clustered board spends 5.2e7 trial visits
 * over its eighteen searches, the grid board 2.9e7. Each account is a
 * fraction of a second of work.
 *
 * The repair account is the exception to four times, because almost nothing
 * spends it: the clustered board repairs for 3e4 visits and no board in the
 * suite for more than 2e4, while one visit there (a group member re-placed)
 * costs about a microsecond. A million is a second at worst; past it the
 * edges left over keep their collided pair.
 */
const LAYOUT_GRID_TESTS = 64_000_000
const LAYOUT_SEGMENT_PAIRS = 64_000_000
const LAYOUT_TRIAL_VISITS = 200_000_000
const LAYOUT_REPAIR_VISITS = 1_000_000

/**
 * The most of the `trials` account ONE side-choice search may spend. The
 * search runs per region of at most 200 edges, and one region can be the
 * whole problem: every edge into one side of one box, every trial touching
 * them all — more than 2e8 visits in one search for 200 sources wired into one
 * side of a hub beside 1800 other boxes. The busiest single search on the
 * suite's and the benches' boards spends 4.7e6, so this is four times that.
 */
const SEARCH_TRIAL_VISITS = 20_000_000

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

/**
 * What one touched edge's pair lookup against one other edge is charged to
 * the `trials` account, in node visits. The lookup swaps a cached pair term
 * for a re-scored one, and measured on boards that crowd one side it costs
 * 0.4-0.7us where one node box visited per path segment costs about 0.06us,
 * so charging it as one visit would let the pair loop, the larger part of a
 * crowded trial, run almost free.
 */
export const PAIR_LOOKUP_VISITS = 8

/**
 * A charge against ONE search's share of the layout's `trials` account
 * (`SEARCH_TRIAL_VISITS`), refusing like `spend` when either the share or
 * the account cannot cover the work: a search runs over one region, so the
 * share bounds a board that crowds one region while the account bounds the
 * regions together.
 */
export function searchShare(budget: RoutingBudget): (work: number) => boolean {
  let share = SEARCH_TRIAL_VISITS
  return (work) => {
    if (work > share || !spend(budget, 'trials', work)) return false
    share -= work
    return true
  }
}

/**
 * Take `work` from one account, or nothing when it cannot cover all of it —
 * the one shape every check takes, so none can spend part and refuse the rest.
 */
export function spend(budget: RoutingBudget, account: 'trials' | 'repairs', work: number): boolean {
  if (work > budget[account]) return false
  budget[account] -= work
  return true
}
