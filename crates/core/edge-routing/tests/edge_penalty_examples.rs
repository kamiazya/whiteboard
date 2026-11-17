//! The penalty tiers on the shapes that decide them: each self and pair term
//! landing on its tier with its quantized length, the branches the ink terms
//! take before measuring, and the cost arithmetic. The inputs and answers
//! are the TypeScript edge rules' examples, which recorded what `selfPenalty`
//! and `pairPenalty` returned before the router moved here.
//!
//! The tier indices are restated from `PENALTY_RULES`' declaration, as the
//! property suite beside this file restates them.

#![expect(clippy::float_cmp, reason = "every cost here is an exact integer")]

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_det::math::js_round;
use whiteboard_edge_routing::edge_crossing_sweep::score_segment_pair;
use whiteboard_edge_routing::edge_ink::COST_QUANTUM;
use whiteboard_edge_routing::edge_rules::{
    Cost, ZERO_COST, add_cost, has_repairable_problem, less_cost, pair_penalty, self_penalty,
};
use whiteboard_edge_routing::geometry::{Point, Rect};

const OVERLAP_AND_INTRUSION: usize = 0;
const ILLEGIBILITY: usize = 1;
const CROSSINGS: usize = 2;
const ENDPOINT_BODY_INK: usize = 3;
const BORDER_TRACING: usize = 4;
const PATH_REVERSAL: usize = 5;
const REALIZED_BENDS: usize = 6;

const fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

const fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, w, h }
}

const SQUARE: Rect = r(0.0, 0.0, 100.0, 100.0);
const WIDE: Rect = r(0.0, 0.0, 100.0, 40.0);

/// The zero cost with one tier set.
fn cost_at(tier: usize, value: f64) -> Cost {
    let mut cost = ZERO_COST;
    cost[tier] = value;
    cost
}

fn q(px: f64) -> f64 {
    px * COST_QUANTUM
}

fn foreign(path: &[Point], bodies: &[Rect]) -> Cost {
    self_penalty(path, bodies, &[], &[])
}

fn borders(path: &[Point], rects: &[Rect]) -> Cost {
    self_penalty(path, &[], rects, &[])
}

fn endpoints(path: &[Point], rects: &[Rect]) -> Cost {
    self_penalty(path, &[], &[], rects)
}

// overlap-and-intrusion

/// A diagonal back through an endpoint body is the straight style's retrace,
/// charged its chord; through a foreign body it is no axis tunnel, and an
/// axis-aligned segment through an endpoint is not read here twice.
#[test]
fn a_diagonal_through_an_endpoint_body_is_an_intrusion() {
    let path = [p(0.0, 0.0), p(100.0, 100.0)];
    let square = r(25.0, 25.0, 50.0, 50.0);
    let chord = js_round(50.0 * core::f64::consts::SQRT_2 * COST_QUANTUM);
    assert_eq!(endpoints(&path, &[square]), cost_at(OVERLAP_AND_INTRUSION, chord));
    assert_eq!(foreign(&path, &[square]), ZERO_COST);
    let across = [p(-10.0, 50.0), p(110.0, 50.0)];
    assert_eq!(endpoints(&across, &[square])[OVERLAP_AND_INTRUSION], 0.0);
}

#[test]
fn collinear_horizontal_segments_overlapping_10px_charge_tier_zero() {
    let triple = score_segment_pair(p(0.0, 0.0), p(20.0, 0.0), p(10.0, 0.0), p(30.0, 0.0));
    assert_eq!(pair_penalty(triple), cost_at(OVERLAP_AND_INTRUSION, q(10.0)));
}

/// Out to x = 20 and back to 5 retraces 15px, reverses once and bends once.
#[test]
fn a_path_retracing_its_own_ink_is_charged_the_retrace() {
    let path = [p(0.0, 0.0), p(20.0, 0.0), p(5.0, 0.0)];
    assert_eq!(foreign(&path, &[]), [q(15.0), 0.0, 0.0, 0.0, 0.0, 1.0, 1.0]);
}

#[test]
fn a_vertical_retrace_is_charged_like_the_horizontal_one() {
    let path = [p(0.0, 0.0), p(0.0, 20.0), p(0.0, 5.0)];
    assert_eq!(foreign(&path, &[]), [q(15.0), 0.0, 0.0, 0.0, 0.0, 1.0, 1.0]);
}

/// Out and back 0.4 of a quantum: the overlap rounds to nothing while the
/// bend is counted off the raw geometry.
#[test]
fn a_retrace_shorter_than_a_quantum_is_no_ink_though_the_turn_is_a_bend() {
    let path = [p(0.0, 0.0), p(0.1, 0.0), p(0.0, 0.0)];
    assert_eq!(foreign(&path, &[]), cost_at(REALIZED_BENDS, 1.0));
}

#[test]
fn a_segment_through_a_foreign_body_is_charged_its_chord() {
    let horizontal = [p(-10.0, 50.0), p(110.0, 50.0)];
    assert_eq!(foreign(&horizontal, &[SQUARE]), cost_at(OVERLAP_AND_INTRUSION, q(100.0)));
    let vertical = [p(50.0, -10.0), p(50.0, 110.0)];
    assert_eq!(foreign(&vertical, &[SQUARE]), cost_at(OVERLAP_AND_INTRUSION, q(100.0)));
}

#[test]
fn a_segment_riding_a_foreign_border_grazes_on_either_axis() {
    assert_eq!(foreign(&[p(-10.0, 0.0), p(110.0, 0.0)], &[SQUARE]), ZERO_COST);
    assert_eq!(foreign(&[p(0.0, -10.0), p(0.0, 110.0)], &[SQUARE]), ZERO_COST);
}

/// The start lies strictly inside the body, so only the diagonal skip keeps
/// this from being charged 90px.
#[test]
fn a_diagonal_tunnels_through_no_foreign_body() {
    assert_eq!(foreign(&[p(10.0, -10.0), p(110.0, 90.0)], &[SQUARE]), ZERO_COST);
}

#[test]
fn a_zero_length_segment_inside_a_foreign_body_is_charged_nothing() {
    assert_eq!(foreign(&[p(50.0, 50.0), p(50.0, 50.0)], &[SQUARE]), ZERO_COST);
}

// illegibility and crossings

/// (1,9)-(9,1) crosses (0,0)-(10,10) near its start.
#[test]
fn a_crossing_near_a_segment_end_is_illegible_and_a_crossing() {
    let triple = score_segment_pair(p(0.0, 0.0), p(10.0, 10.0), p(1.0, 9.0), p(9.0, 1.0));
    assert_eq!(pair_penalty(triple), [0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0]);
}

#[test]
fn a_clean_crossing_far_from_every_end_is_one_crossing_and_legible() {
    let triple = score_segment_pair(p(0.0, 0.0), p(100.0, 100.0), p(0.0, 100.0), p(100.0, 0.0));
    let cost = pair_penalty(triple);
    assert_eq!(cost, cost_at(CROSSINGS, 1.0));
    assert_eq!(cost[ILLEGIBILITY], 0.0);
    assert_eq!(cost[PATH_REVERSAL], 0.0);
}

#[test]
fn a_collinear_overlap_is_not_also_counted_as_a_crossing() {
    let triple = score_segment_pair(p(0.0, 0.0), p(20.0, 0.0), p(10.0, 0.0), p(30.0, 0.0));
    assert!(triple[0] > 0.0);
    assert_eq!(pair_penalty(triple)[CROSSINGS], 0.0);
}

// border-tracing

#[test]
fn a_segment_along_a_border_is_charged_the_overlap_on_either_axis() {
    let along_top = [p(0.0, 0.0), p(100.0, 0.0)];
    assert_eq!(borders(&along_top, &[WIDE]), cost_at(BORDER_TRACING, q(100.0)));
    let along_right = [p(100.0, 0.0), p(100.0, 40.0)];
    assert_eq!(borders(&along_right, &[WIDE]), cost_at(BORDER_TRACING, q(40.0)));
}

#[test]
fn a_segment_that_only_touches_misses_or_parallels_a_border_traces_nothing() {
    let touching = [p(50.0, -20.0), p(50.0, 0.0)];
    let one_pixel_off = [p(0.0, 1.0), p(100.0, 1.0)];
    let past_the_corner = [p(150.0, 0.0), p(200.0, 0.0)];
    for path in [touching, one_pixel_off, past_the_corner] {
        assert_eq!(borders(&path, &[WIDE]), ZERO_COST, "{path:?}");
    }
}

#[test]
fn a_border_overlap_is_clipped_to_the_side_when_the_segment_overhangs_both_corners() {
    let path = [p(-50.0, 0.0), p(200.0, 0.0)];
    assert_eq!(borders(&path, &[WIDE])[BORDER_TRACING], q(100.0));
}

#[test]
fn a_zero_height_rect_is_traced_once_not_twice() {
    let path = [p(0.0, 0.0), p(100.0, 0.0)];
    assert_eq!(borders(&path, &[r(0.0, 0.0, 100.0, 0.0)])[BORDER_TRACING], q(100.0));
}

/// The foreign bodies leave an edge's own ends out; the borders do not.
#[test]
fn border_tracing_fires_against_the_paths_own_endpoint_node() {
    let path = [p(0.0, 0.0), p(100.0, 0.0)];
    assert_eq!(self_penalty(&path, &[WIDE], &[WIDE], &[]), cost_at(BORDER_TRACING, q(100.0)));
    assert_eq!(foreign(&path, &[]), ZERO_COST);
}

// endpoint-body-ink

#[test]
fn a_segment_strictly_inside_an_endpoint_body_is_charged_its_clipped_chord() {
    let horizontal = [p(-10.0, 20.0), p(110.0, 20.0)];
    assert_eq!(endpoints(&horizontal, &[WIDE]), cost_at(ENDPOINT_BODY_INK, q(100.0)));
    let vertical = [p(50.0, -10.0), p(50.0, 50.0)];
    assert_eq!(endpoints(&vertical, &[WIDE]), cost_at(ENDPOINT_BODY_INK, q(40.0)));
    // Nothing is charged when the rect is not declared an endpoint.
    assert_eq!(foreign(&horizontal, &[]), ZERO_COST);
}

/// Border-tracing prices a segment on the border; this tier does not.
#[test]
fn a_segment_on_the_border_is_not_also_endpoint_body_ink() {
    let cost = self_penalty(&[p(0.0, 0.0), p(100.0, 0.0)], &[], &[WIDE], &[WIDE]);
    assert_eq!(cost[ENDPOINT_BODY_INK], 0.0);
    assert_eq!(cost[BORDER_TRACING], q(100.0));
}

#[test]
fn a_segment_leaving_its_own_border_perpendicularly_is_no_body_ink() {
    assert_eq!(endpoints(&[p(50.0, -20.0), p(50.0, 0.0)], &[WIDE]), ZERO_COST);
}

/// The outer rect contains the inner, so only the inner's [10, 30] counts.
#[test]
fn an_endpoint_rect_containing_the_other_is_left_out() {
    let inner = r(10.0, 10.0, 20.0, 10.0);
    let path = [p(-10.0, 15.0), p(110.0, 15.0)];
    assert_eq!(endpoints(&path, &[SQUARE, inner])[ENDPOINT_BODY_INK], q(20.0));
}

#[test]
fn overlapping_endpoint_rects_neither_containing_the_other_are_both_priced() {
    let a = r(0.0, 0.0, 30.0, 20.0);
    let b = r(20.0, 0.0, 30.0, 20.0);
    let path = [p(-10.0, 10.0), p(60.0, 10.0)];
    assert_eq!(endpoints(&path, &[a, b])[ENDPOINT_BODY_INK], q(60.0));
}

/// Equal rects (a self-loop, or two same-size nodes stacked) contain each
/// other, so neither PROPERLY contains the other and both are priced.
#[test]
fn two_equal_endpoint_rects_are_not_excluded_by_each_other() {
    let rect = r(0.0, 0.0, 50.0, 50.0);
    let path = [p(-10.0, 25.0), p(60.0, 25.0)];
    assert_eq!(endpoints(&path, &[rect, rect])[ENDPOINT_BODY_INK], 2.0 * q(50.0));
}

#[test]
fn a_flat_endpoint_rect_has_no_interior_to_ink() {
    let flats = [r(0.0, 0.0, 100.0, 0.0), r(0.0, 0.0, 0.0, 100.0)];
    let path = [p(-10.0, 0.0), p(110.0, 0.0)];
    assert_eq!(endpoints(&path, &flats)[ENDPOINT_BODY_INK], 0.0);
}

// path-reversal and realized-bends

/// Each row: a path, its reversals, its bends.
#[test]
fn reversals_and_bends_of_the_named_shapes() {
    let knot = [
        p(233.333_333_333_333_31, 570.0),
        p(233.333_333_333_333_31, 550.0),
        p(226.0, 550.0),
        p(226.0, 560.0),
        p(246.0, 560.0),
    ];
    let rows: [(&str, &[Point], f64, Option<f64>); 9] = [
        ("straight", &[p(0.0, 0.0), p(10.0, 0.0)], 0.0, Some(0.0)),
        ("L", &[p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0)], 0.0, Some(1.0)),
        ("Z", &[p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(20.0, 10.0)], 0.0, Some(2.0)),
        ("U-hook", &[p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)], 1.0, None),
        ("the reported knot, reversing on both axes", &knot, 2.0, None),
        ("empty", &[], 0.0, Some(0.0)),
        ("single point", &[p(0.0, 0.0)], 0.0, Some(0.0)),
        ("repeated points", &[p(0.0, 0.0), p(0.0, 0.0), p(0.0, 0.0)], 0.0, None),
        ("zero-length then straight", &[p(0.0, 0.0), p(0.0, 0.0), p(10.0, 0.0)], 0.0, Some(0.0)),
    ];
    for (label, path, reversals, bends) in rows {
        let cost = foreign(path, &[]);
        assert_eq!(cost[PATH_REVERSAL], reversals, "{label}: {cost:?}");
        if let Some(bends) = bends {
            assert_eq!(cost[REALIZED_BENDS], bends, "{label}: {cost:?}");
        }
        assert!(cost.iter().all(|n| n.is_finite() && *n >= 0.0), "{label}: {cost:?}");
    }
    assert_eq!(foreign(&[p(5.0, 5.0), p(5.0, 5.0)], &[])[PATH_REVERSAL], 0.0);
}

// has_repairable_problem, add_cost and less_cost

#[test]
fn every_tier_but_realized_bends_is_repairable() {
    assert!(!has_repairable_problem(&cost_at(REALIZED_BENDS, 5.0)));
    assert!(!has_repairable_problem(&ZERO_COST));
    for tier in 0..REALIZED_BENDS {
        assert!(has_repairable_problem(&cost_at(tier, 1.0)), "tier {tier}");
        assert!(has_repairable_problem(&cost_at(tier, 7.0)), "tier {tier}");
    }
    assert!(has_repairable_problem(&[1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 5.0]));
}

#[test]
fn add_cost_sums_and_subtracts_tier_by_tier() {
    let small = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0];
    let large = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0];
    assert_eq!(add_cost(&small, &large, 1.0), [11.0, 22.0, 33.0, 44.0, 55.0, 66.0, 77.0]);
    assert_eq!(add_cost(&large, &small, -1.0), [9.0, 18.0, 27.0, 36.0, 45.0, 54.0, 63.0]);
}

/// Tier 0 decides before tier 1 is read, however tier 1 compares.
#[test]
fn less_cost_compares_tier_zero_before_tier_one() {
    let a = [5.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    let b = [3.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    assert!(!less_cost(&a, &b));
    assert!(less_cost(&b, &a));
}
