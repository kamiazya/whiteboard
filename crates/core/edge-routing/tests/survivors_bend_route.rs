//! Where a bent edge meets its boxes when nothing names the point or the
//! side: the border nearest the bend next to it. cargo-mutants showed the
//! left and right borders were pinned by no test. The expected values are
//! what canvas-render's `bend-route.ts` returns for the same input.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::bend_route::{BendRouteEnds, bend_route};
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::routing_input::{RoutableEdge, RoutingEnd};

const fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

/// A box away from the origin, so a gap measured from the wrong edge, or a
/// border point at the wrong x, shows. The first bend lies due left of the
/// box; the last lies right of it and just below its top, so the right
/// border (gap 0) beats the top (gap 0.5) only when its gap is measured
/// exactly.
#[test]
fn a_bend_beside_a_box_meets_it_on_the_left_or_right_border() {
    let on = |node| RoutingEnd::Node { node, side: None, arrowhead: None };
    let edge = RoutableEdge {
        id: 0,
        from: on(1),
        to: on(2),
        bends: Some(vec![p(0.0, 120.0), p(200.0, 100.5)]),
    };
    let rect = Rect { x: 100.0, y: 100.0, w: 40.0, h: 40.0 };
    assert_eq!(
        bend_route(&edge, rect, rect, &BendRouteEnds::default()),
        Some(vec![p(100.0, 120.0), p(0.0, 120.0), p(200.0, 100.5), p(140.0, 100.5)])
    );
}
