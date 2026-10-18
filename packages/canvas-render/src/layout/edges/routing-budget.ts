/**
 * What one layout may spend on the two parts of edge routing whose cost grows
 * faster than the board: the grid router (`grid-route.ts`) and the side-choice
 * search's segment-pair scoring (`spatial-edges.ts`).
 *
 * Both are bounded per CALL by something else — the grid by its cell cap, the
 * search by its edge gate and trial budget — and neither bound sees the term
 * that actually grows. A grid call buckets every obstacle in its window
 * against every grid line, and copies of one obstacle add obstacles without
 * adding a line or a cell. A trial re-scores every segment pair of the edges
 * it touched, and an edge drawn through its stored bends brings up to
 * MAX_BENDS + 1 segments to every pair. A board built for either stalls the
 * layout for minutes while staying inside every model ceiling.
 *
 * Past the budget each search keeps the answer it falls back to anyway: the
 * grid router returns nothing, so the enumerated candidate stands, and the
 * side-choice search stops with the sides it has, a partial repair. Below it
 * nothing changes — every check refuses only work the account cannot cover.
 */
export interface RoutingBudget {
  /**
   * Obstacle tests the grid router may still make: one obstacle against one
   * grid line while bucketing, one bucketed obstacle per search step.
   */
  grid: number
  /** Segment pairs the side-choice search may still examine, built or re-scored. */
  pairs: number
}

/**
 * Sized against the largest boards in the suite and the benches, at about
 * four times what the busiest of them spends: a 2000-node, 1837-edge
 * clustered board makes 1.4e7 grid tests in one layout, and a 2000-node,
 * 2000-edge grid board 6e6 pair tests (3e6 on the 200-edge dense bench, in
 * one region). Each account is a fraction of a second of work.
 */
const LAYOUT_GRID_TESTS = 64_000_000
const LAYOUT_SEGMENT_PAIRS = 64_000_000

/**
 * The running account for ONE layout. A counter rather than a value threaded
 * functionally, because every route and every trial in the layout spends from
 * the same pool and none of them returns anything to hand the rest back.
 */
export function createRoutingBudget(): RoutingBudget {
  return { grid: LAYOUT_GRID_TESTS, pairs: LAYOUT_SEGMENT_PAIRS }
}
