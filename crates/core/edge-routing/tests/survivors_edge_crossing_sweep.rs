//! The pairwise crossing scorer's answers that cargo-mutants showed no other
//! test pinned. Every expected value is what canvas-render's
//! `edge-crossing-sweep.ts` returns for the same input.
//!
//! The broad phase's y-gate is safe to loosen or tighten by one slack step
//! only while the quarter-pixel slack actually moves a coordinate. From
//! 2^53 up a coordinate's spacing is at least 2, so the slack rounds away,
//! and two collinear runs on one such line meet the gate exactly at its
//! boundary.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::edge_crossing_sweep::{
    PairScore, build_pairwise_scores, score_quantized_segment_pair,
};
use whiteboard_edge_routing::geometry::Point;

const fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn scores(paths: &[Vec<Point>]) -> Vec<(usize, PairScore)> {
    build_pairwise_scores(paths, None)
        .map(|map| map.iter().map(|(k, v)| (*k, *v)).collect())
        .unwrap_or_default()
}

/// Two spans that both sit at +infinity share no length: the overlap is
/// only taken when its far end lies strictly past its near one, which keeps
/// `inf - inf` out of it.
#[test]
fn spans_meeting_at_infinity_overlap_by_nothing() {
    let inf = f64::INFINITY;
    let score = score_quantized_segment_pair([inf, 0.0, inf, 0.0], [inf, 0.0, inf, 0.0]);
    assert_eq!(score.map(f64::to_bits), [0.0_f64.to_bits(); 3]);
}

/// Collinear runs on a line past 2^53 still have their overlap scored:
/// the slack cannot separate their y-spans, which therefore touch exactly,
/// and touching spans pass the gate.
#[test]
fn collinear_runs_on_a_far_line_still_overlap() {
    // 2^54, where neighbouring values are 4 apart.
    let y = 18_014_398_509_481_984.0;
    let paths = [vec![p(0.0, y), p(10.0, y)], vec![p(5.0, y), p(15.0, y)]];
    assert_eq!(scores(&paths), vec![(1, [20.0, 0.0, 0.0])]);
}

/// A pair whose y-spans are apart is never scored, even when the narrow
/// phase would call it a crossing: here every product overflows, so `t`,
/// `u` and the denominator are all NaN and pass the open-interval test.
#[test]
fn a_pair_apart_in_y_is_not_scored_even_when_its_products_overflow() {
    let paths = [vec![p(0.0, 0.0), p(1e200, 1e200)], vec![p(1e200, 2e200), p(2e200, 3e200)]];
    assert_eq!(scores(&paths), vec![]);
}
