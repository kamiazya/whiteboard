//! The anchor pass's answers that cargo-mutants showed no other test
//! pinned: when a facing pair is slid onto one lane, and what a pin writes
//! over a placed entry. Every expected value is what canvas-render's
//! `computeAnchorsFor` returns for the same input.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::edge_anchors::{anchor_context, compute_anchors_for};
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_rules::SidePair;
use whiteboard_edge_routing::edge_sides::{EdgeAnchorOverride, EdgeAnchorPair};
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::routing_input::{RoutableEdge, RoutingEnd, RoutingNode};

const fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

const fn sides(from_side: Side, to_side: Side) -> SidePair {
    SidePair { from_side, to_side, around: false }
}

/// One edge from box 0 to box 1 on the given sides, its entry as
/// `computeAnchorsFor(ctx, sides, align, pins)` places it.
fn anchors(
    boxes: [Rect; 2],
    chosen: SidePair,
    align: bool,
    pin: Option<EdgeAnchorOverride>,
) -> Option<EdgeAnchorPair> {
    let nodes = [RoutingNode { id: 0, rect: boxes[0] }, RoutingNode { id: 1, rect: boxes[1] }];
    let end = |node| RoutingEnd::Node { node, side: None, arrowhead: None };
    let edges = [RoutableEdge { id: 0, from: end(0), to: end(1), bends: None }];
    let ctx = anchor_context(&nodes, &edges);
    let chosen_sides: JsMap<u32, SidePair> = [(0, chosen)].into_iter().collect();
    let pins: Option<JsMap<u32, EdgeAnchorOverride>> =
        pin.map(|pin| [(0, pin)].into_iter().collect());
    compute_anchors_for(&ctx, &chosen_sides, align, pins.as_ref(), None).get(&0).copied()
}

const fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, w, h }
}

/// Facing sides whose boxes overlap along the lane's axis are not slid onto
/// one lane: each anchor stays at its side's midpoint. One case per
/// direction the clearance test reads the far box's extent in.
#[test]
fn facing_sides_of_overlapping_boxes_keep_their_midpoints() {
    let unslid = |from, from_side, to, to_side| EdgeAnchorPair {
        from: Some(from),
        to: Some(to),
        from_lane_depth: Some(20.0),
        to_lane_depth: Some(20.0),
        from_side: Some(from_side),
        to_side: Some(to_side),
        around: false,
    };
    let cases = [
        (
            [rect(100.0, 0.0, 100.0, 100.0), rect(50.0, 40.0, 100.0, 100.0)],
            sides(Side::Left, Side::Right),
            unslid(p(100.0, 50.0), Side::Left, p(150.0, 90.0), Side::Right),
        ),
        (
            [rect(0.0, 0.0, 100.0, 100.0), rect(40.0, 50.0, 100.0, 100.0)],
            sides(Side::Bottom, Side::Top),
            unslid(p(50.0, 100.0), Side::Bottom, p(90.0, 50.0), Side::Top),
        ),
        (
            [rect(0.0, 100.0, 100.0, 100.0), rect(40.0, 50.0, 100.0, 100.0)],
            sides(Side::Top, Side::Bottom),
            unslid(p(50.0, 100.0), Side::Top, p(90.0, 150.0), Side::Bottom),
        ),
    ];
    for (boxes, chosen, expected) in cases {
        assert_eq!(anchors(boxes, chosen, true, None), Some(expected), "{chosen:?}");
    }
}

/// A pin overrides each committed field on its own: the `to` point and both
/// lane depths it carries replace the placed ones, and the `from` point it
/// leaves out stays as placed.
#[test]
fn a_pin_writes_every_field_it_carries() {
    let pin = EdgeAnchorOverride {
        sides: sides(Side::Right, Side::Left),
        from: None,
        from_lane_depth: Some(7.0),
        to: Some(p(300.0, 33.0)),
        to_lane_depth: Some(9.0),
    };
    let boxes = [rect(0.0, 0.0, 100.0, 100.0), rect(300.0, 0.0, 100.0, 100.0)];
    assert_eq!(
        anchors(boxes, sides(Side::Right, Side::Left), false, Some(pin)),
        Some(EdgeAnchorPair {
            from: Some(p(100.0, 50.0)),
            to: Some(p(300.0, 33.0)),
            from_lane_depth: Some(7.0),
            to_lane_depth: Some(9.0),
            from_side: Some(Side::Right),
            to_side: Some(Side::Left),
            around: false,
        })
    );
}
