//! One layout's edge routing in one call (ADR-0054 decision 9, QR-22b): the
//! side-choice search over every edge, then each edge routed between the
//! anchors it settled, on one budget — what canvas-render's
//! `composeEdgesAndLabels` does between `assignEdgeAnchors` and its
//! per-edge `routeEdge`, so a layout crosses the boundary once rather than
//! once per edge.

use crate::edge_router::{RouteRequest, RoutedEdge, RoutingStyle, route_edge};
use crate::edge_sides::EdgeAnchorOverride;
use crate::geometry::Rect;
use crate::js_map::JsMap;
use crate::routing_budget::RoutingBudget;
use crate::routing_input::{EdgeId, RoutableEdge, RoutingNode};
use crate::spatial_edges::assign_edge_anchors;

/// Every edge of `edges` routed, in order, as the composer routes them:
/// anchors from [`assign_edge_anchors`], no obstacle list of the caller's
/// own, and the labels both passes avoid. `styles` holds one style per edge,
/// by position.
#[must_use]
pub fn route_layout(
    (nodes, labels): (&[RoutingNode], &[Rect]),
    (edges, styles): (&[RoutableEdge], &[RoutingStyle]),
    side_overrides: Option<&JsMap<EdgeId, EdgeAnchorOverride>>,
    budget: &mut RoutingBudget,
) -> Vec<RoutedEdge> {
    let anchors = assign_edge_anchors((nodes, labels), (edges, styles), side_overrides, budget);
    edges
        .iter()
        .enumerate()
        .map(|(i, edge)| {
            let style = styles.get(i).copied().unwrap_or(RoutingStyle::Straight);
            let request = RouteRequest {
                anchors: anchors.get(&edge.id),
                others: None,
                budget: Some(&mut *budget),
                labels,
            };
            route_edge(nodes, edge, style, request)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::route_layout;
    use crate::edge_router::RoutingStyle;
    use crate::geometry::Rect;
    use crate::routing_budget::RoutingBudget;
    use crate::routing_input::{RoutableEdge, RoutingEnd, RoutingNode};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn node(id: u32, x: f64) -> RoutingNode {
        RoutingNode { id, rect: Rect { x, y: 0.0, w: 100.0, h: 50.0 } }
    }

    fn edge(id: u32, from: u32, to: u32) -> RoutableEdge {
        let end = |node| RoutingEnd::Node { node, side: None, arrowhead: None };
        RoutableEdge { id, from: end(from), to: end(to), bends: None }
    }

    #[test]
    fn no_edges_route_to_nothing_and_spend_nothing() {
        let mut budget = RoutingBudget::for_layout();
        let routed = route_layout((&[node(0, 0.0)], &[]), (&[], &[]), None, &mut budget);
        assert!(routed.is_empty());
        assert_eq!(budget, RoutingBudget::for_layout());
    }

    #[test]
    fn every_edge_is_routed_in_input_order_a_dangling_one_included() {
        let nodes = [node(0, 0.0), node(1, 300.0)];
        let edges = [edge(0, 0, 1), edge(1, 1, 0), edge(2, 0, 9)];
        let styles = [RoutingStyle::Orthogonal; 3];
        let mut budget = RoutingBudget::for_layout();
        let routed = route_layout((&nodes, &[]), (&edges, &styles), None, &mut budget);
        assert_eq!(routed.len(), 3);
        let xs = |i: usize| {
            let path = &routed[i].path;
            (path.first().map_or(f64::NAN, |p| p.x), path.last().map_or(f64::NAN, |p| p.x))
        };
        // Left to right, then right to left: the box at x 0..100 and the one at 300..400.
        assert!(xs(0).0 <= 100.0 && xs(0).1 >= 300.0);
        assert!(xs(1).0 >= 300.0 && xs(1).1 <= 100.0);
        // An end naming no node draws nothing it could be routed along.
        assert!(routed[2].path.windows(2).all(|w| w[0] == w[1]));
    }
}
