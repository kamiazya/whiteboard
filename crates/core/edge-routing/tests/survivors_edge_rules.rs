//! Side rankings and lane windows that cargo-mutants showed no other test
//! pinned. Every expected value is what canvas-render's `edge-rules.ts`
//! (`composeSidePairs`, `facingLaneWindow`) returns for the same input.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_geometry::Side::{Bottom as B, Left as L, Right as R, Top as T};
use whiteboard_edge_routing::edge_rules::{
    End, LaneAxis, PreferenceContext, compose_side_pairs, facing_lane_window,
};
use whiteboard_edge_routing::geometry::Rect;

const fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, w, h }
}

fn ranked(dx: f64, dy: f64, from_rect: Rect, to_rect: Rect) -> Vec<(Side, Side)> {
    let no_crowd = |_: End, _: Side| 0.0;
    let ctx = PreferenceContext { dx, dy, from_rect, to_rect, crowd: &no_crowd };
    compose_side_pairs(&ctx).into_iter().map(|p| (p.from_side, p.to_side)).collect()
}

/// A negative extent makes the corner inset its own negative half, so the
/// side collapses to a point and opens no lane, however wide the other box.
#[test]
fn a_box_with_a_negative_extent_opens_no_facing_lane() {
    let flat = r(0.0, 0.0, 50.0, -40.0);
    assert_eq!(facing_lane_window(flat, r(0.0, -100.0, 50.0, 300.0), LaneAxis::H), None);
    let narrow = r(0.0, 0.0, -40.0, 50.0);
    assert_eq!(facing_lane_window(narrow, r(-100.0, 0.0, 300.0, 50.0), LaneAxis::V), None);
}

/// Heading up (dy < 0) into a box that overlaps this one vertically is no
/// facing gap, so with dx = 0 the case is degenerate and the U-hooks lead.
#[test]
fn heading_up_into_an_overlapping_box_ranks_the_u_hooks_first() {
    assert_eq!(
        ranked(0.0, -10.0, r(0.0, 50.0, 100.0, 100.0), r(0.0, 0.0, 100.0, 100.0)),
        [(R, R), (L, L), (T, B), (R, L), (B, B), (T, T)]
    );
}

/// One facing gap is enough to keep the early U-hooks out, even when the
/// shared lane is too narrow for a zero-bend pair and dy = 0 rules out the
/// L pairs.
#[test]
fn a_single_valid_facing_gap_keeps_the_degenerate_u_hooks_out() {
    assert_eq!(
        ranked(50.0, 0.0, r(0.0, 0.0, 100.0, 30.0), r(200.0, 0.0, 100.0, 30.0)),
        [(R, L), (B, T), (T, T), (R, R), (B, B), (L, L)]
    );
}

/// With no gap at all but both offsets non-zero, the L pairs are candidates,
/// so the case is not degenerate and no U-hook is ranked early.
#[test]
fn overlapping_boxes_with_both_offsets_rank_l_pairs_before_any_u_hook() {
    assert_eq!(
        ranked(50.0, 10.0, r(0.0, 0.0, 100.0, 100.0), r(50.0, 50.0, 100.0, 100.0)),
        [(R, T), (B, L), (R, L), (B, T), (T, T), (L, L), (R, R), (B, B)]
    );
}

/// Only this box's right side runs through the other's interior, so its
/// U-hook goes last and the other three keep their order.
#[test]
fn the_u_hook_whose_side_runs_through_the_other_box_ranks_last() {
    assert_eq!(
        ranked(50.0, 10.0, r(0.0, 0.0, 100.0, 100.0), r(50.0, 20.0, 100.0, 40.0)),
        [(R, T), (B, L), (R, L), (B, T), (T, T), (B, B), (L, L), (R, R)]
    );
}
