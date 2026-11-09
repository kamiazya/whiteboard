//! The budget each test export writes back, which cargo-mutants showed no
//! other test pinned: an account the caller sets is the one spent, not the
//! layout default beside it. Every expected value is what canvas-render's
//! `buildPairwiseScores` and `routeEdge` leave in the account they are
//! handed.

use whiteboard_wasm::edge_crossing_sweep::edge_pairwise_scores;
use whiteboard_wasm::edge_router::edge_route_edge;

/// Two crossing diagonals, then the pairs account as set and its value.
fn crossing_pair(pairs: f64) -> Vec<f64> {
    vec![2.0, 2.0, 0.0, 0.0, 100.0, 100.0, 2.0, 0.0, 100.0, 100.0, 0.0, 1.0, pairs]
}

/// One segment pair is all two one-segment paths cost, taken from the
/// account the caller set; an account of none refuses and spends nothing.
#[test]
fn the_pairs_account_the_caller_sets_is_the_one_spent() {
    assert_eq!(
        edge_pairwise_scores(&crossing_pair(3.0)),
        [2.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0]
    );
    assert_eq!(edge_pairwise_scores(&crossing_pair(0.0)), [-1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
}

/// Five boxes whose elbow and detour candidates from 1 to 2 are all
/// blocked, so the route falls through to the grid search; then the
/// orthogonal style, no anchors, no `others`, the grid account as set and
/// its value, and no labels.
fn boxed_in_edge(grid: f64) -> Vec<f64> {
    let mut input = vec![5.0];
    input.extend([1.0, 0.0, 100.0, 100.0, 30.0, 2.0, 0.0, 100.0, 70.0, 30.0]);
    input.extend([3.0, 350.0, 300.0, 100.0, 60.0, 4.0, 0.0, 0.0, 40.0, 90.0]);
    input.extend([5.0, 100.0, 200.0, 100.0, 60.0]);
    input.extend([1.0, 9.0, 0.0, 1.0, 0.0, -1.0, -1.0, 0.0, 2.0, 0.0, -1.0, -1.0, -1.0]);
    input.extend([1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, -1.0, 0.0]);
    input.extend([-1.0, 1.0, grid, 0.0]);
    input
}

/// The search spends from the account the caller set: enough, and it spends
/// what it tested; too little even to bucket the obstacles, and it is
/// refused before testing anything.
#[test]
fn the_grid_account_the_caller_sets_is_the_one_spent() {
    // `[spent, rounded, from side, to side, from end, to end, point count,
    // then x, y per point]`: top to top, both times on the same route.
    let route = [0.0, 0.0, 0.0, 1.0, 4.0, 50.0, 100.0, 50.0, 80.0, 35.0, 80.0, 35.0, 100.0];
    let answer = |spent: f64| [&[spent, 0.0][..], &route[..]].concat();
    assert_eq!(edge_route_edge(&boxed_in_edge(1e9)), answer(281.0));
    assert_eq!(edge_route_edge(&boxed_in_edge(1.0)), answer(0.0));
}
