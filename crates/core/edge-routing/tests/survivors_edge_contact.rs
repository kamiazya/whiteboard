//! Concrete answers of the contact mark that cargo-mutants showed no other
//! test pinned. Every expected value is what canvas-render's
//! `contactRoute` returns for the same boxes.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::edge_contact::{Contact, contact_for};
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::routing_input::{RoutableEdge, RoutingEnd};

fn edge() -> RoutableEdge {
    RoutableEdge {
        id: 0,
        from: RoutingEnd::Node { node: 1, side: None, arrowhead: None },
        to: RoutingEnd::Node { node: 2, side: None, arrowhead: None },
        bends: None,
    }
}

/// The shortest mark that still has a direction is exactly one pixel: a
/// source one pixel wide gets it, half a pixel gets none.
#[test]
fn a_one_pixel_source_gets_a_one_pixel_mark_and_a_half_pixel_one_none() {
    let to = Rect { x: 1.0, y: 0.0, w: 10.0, h: 10.0 };
    let from = Rect { x: 0.0, y: 0.0, w: 1.0, h: 10.0 };
    let mark = Contact {
        path: [Point { x: 0.0, y: 5.0 }, Point { x: 1.0, y: 5.0 }],
        from_side: Side::Right,
        to_side: Side::Left,
    };
    assert_eq!(contact_for(&edge(), from, to), Some(mark));
    let half = Rect { x: 0.0, y: 0.0, w: 0.5, h: 10.0 };
    assert_eq!(contact_for(&edge(), half, Rect { x: 0.5, ..to }), None);
}
