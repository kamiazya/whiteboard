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
