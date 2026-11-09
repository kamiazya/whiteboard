//! Concrete answers of the edge geometry helpers that cargo-mutants showed
//! no other test pinned. Every expected value is what canvas-render's
//! `edge-geometry.ts` returns for the same input.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::edge_geometry::{
    MidpointExtent, bounding_box_of, midpoint_extent, segment_crosses_rect, strictly_inside,
};
use whiteboard_edge_routing::geometry::{Point, Rect};

const fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

/// The left, right and top borders are each outside the strict interior,
/// while the centre is inside.
#[test]
fn a_point_on_the_left_right_or_top_border_is_not_strictly_inside() {
    let r = Rect { x: 0.0, y: 0.0, w: 10.0, h: 10.0 };
    assert!(!strictly_inside(r, p(0.0, 5.0)));
    assert!(!strictly_inside(r, p(10.0, 5.0)));
    assert!(!strictly_inside(r, p(5.0, 0.0)));
    assert!(strictly_inside(r, p(5.0, 5.0)));
}

/// A rect of negative extent is rejected by the bounding-box test alone:
/// the slab narrowing behind it reads the swapped borders as an interval and
/// would answer that the segment crosses it.
#[test]
fn a_segment_past_the_near_border_of_an_inverted_rect_does_not_cross_it() {
    let inverted_x = Rect { x: 10.0, y: 0.0, w: -5.0, h: 10.0 };
    assert!(!segment_crosses_rect(p(6.0, 5.0), p(12.0, 5.0), inverted_x));
    let inverted_y = Rect { x: 0.0, y: 10.0, w: 10.0, h: -5.0 };
    assert!(!segment_crosses_rect(p(5.0, 6.0), p(5.0, 12.0), inverted_y));
}

/// A later point equal to the bound keeps the first one, so `+0` before
/// `-0` leaves `+0` as both the minimum and the maximum.
#[test]
fn a_tie_between_signed_zeros_keeps_the_first_as_the_bound() {
    let bb = bounding_box_of(&[p(0.0, 0.0), p(-0.0, -0.0)]);
    for (name, v) in [("x", bb.x), ("y", bb.y), ("w", bb.w), ("h", bb.h)] {
        assert_eq!(v.to_bits(), 0.0_f64.to_bits(), "{name} is {v:?}, expected +0");
    }
}

/// A midpoint with one non-finite coordinate is dropped whole, and each span
/// is the distance between the extremes rather than their sum.
#[test]
fn a_half_finite_midpoint_is_skipped_and_spans_are_max_minus_min() {
    let extent = midpoint_extent(&[p(5.0, f64::NAN), p(10.0, 20.0), p(20.0, 40.0)]);
    assert_eq!(
        extent,
        MidpointExtent { span_x: 10.0, span_y: 20.0, origin_x: 10.0, origin_y: 20.0 }
    );
}
