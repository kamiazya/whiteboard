//! Orthogonal routes whose answer depends on how far the detour pass's work
//! window reaches, which cargo-mutants showed no other test pinned. The
//! expected paths are what canvas-render's `routeEdge` returns for the same
//! boards.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_router::{RouteRequest, RoutingStyle, route_edge};
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::routing_input::{RoutableEdge, RoutingEnd, RoutingNode};

const fn n(id: u32, x: f64, y: f64, w: f64, h: f64) -> RoutingNode {
    RoutingNode { id, rect: Rect { x, y, w, h } }
}

fn path(points: &[(f64, f64)]) -> Vec<Point> {
    points.iter().map(|&(x, y)| Point { x, y }).collect()
}

fn route(nodes: &[RoutingNode], from_side: Side, to_side: Side) -> Vec<Point> {
    let on = |node, side| RoutingEnd::Node { node, side: Some(side), arrowhead: None };
    let edge = RoutableEdge { id: 0, from: on(1, from_side), to: on(2, to_side), bends: None };
    route_edge(nodes, &edge, RoutingStyle::Orthogonal, RouteRequest::default()).path
}

/// Two half-pixel-wide boxes stacked so the edge runs back up through both:
/// the detour region is half a pixel wide, and the window still reaches the
/// clearance past its far side, so the box blocking the right-hand detour is
/// seen and that detour is not taken.
#[test]
fn a_detour_round_half_pixel_wide_ends_still_sees_the_box_past_its_far_side() {
    let nodes = [
        n(1, 0.0, 100.0, 0.5, 20.0),
        n(2, 0.0, 0.0, 0.5, 20.0),
        n(3, -22.0, 50.0, 10.0, 20.0),
        n(4, 12.0, 50.0, 10.0, 20.0),
    ];
    assert_eq!(
        route(&nodes, Side::Bottom, Side::Top),
        path(&[(0.25, 120.0), (0.25, 140.0), (0.25, -16.0), (0.25, 0.0)])
    );
}

/// The same board turned on its side: the window's height is what reaches
/// the box blocking the lower detour.
#[test]
fn a_detour_round_half_pixel_tall_ends_still_sees_the_box_past_its_far_side() {
    let nodes = [
        n(1, 100.0, 0.0, 20.0, 0.5),
        n(2, 0.0, 0.0, 20.0, 0.5),
        n(3, 50.0, -22.0, 20.0, 10.0),
        n(4, 50.0, 12.0, 20.0, 10.0),
    ];
    assert_eq!(
        route(&nodes, Side::Right, Side::Left),
        path(&[(120.0, 0.25), (140.0, 0.25), (-16.0, 0.25), (0.0, 0.25)])
    );
}
