/**
 * What one layout may spend on the part of edge routing whose cost grows
 * faster than the board: the grid router (`grid-route.ts`).
 *
 * Each grid call is bounded in CELLS by `MAX_GRID_CELLS`, and that bound does
 * not see the term that actually grows: a call buckets every obstacle in its
 * window against every grid line, and copies of one obstacle add obstacles
 * without adding a line or a cell. The side-choice search re-routes each edge
 * under every side pair it tries, so a board built for it calls the grid
 * thousands of times in one layout and stalls it for minutes while staying
 * inside every model ceiling.
 *
 * Past the budget the grid router returns nothing, so the enumerated
 * candidate stands — the answer it falls back to anyway. Below it nothing
 * changes: every check refuses only work the account cannot cover.
 */
export interface RoutingBudget {
  /**
   * Obstacle tests the grid router may still make: one obstacle against one
   * grid line while bucketing, one bucketed obstacle per search step.
   */
  grid: number
}

/**
 * Sized against the largest boards in the suite and the benches, at about
 * four times what the busiest of them spends: a 2000-node, 1837-edge
 * clustered board makes 1.4e7 grid tests in one layout. The account is a
 * fraction of a second of work.
 */
const LAYOUT_GRID_TESTS = 64_000_000

/**
 * The running account for ONE layout. A counter rather than a value threaded
 * functionally, because every route in the layout spends from the same pool
 * and none of them returns anything to hand the rest back.
 */
export function createRoutingBudget(): RoutingBudget {
  return { grid: LAYOUT_GRID_TESTS }
}
