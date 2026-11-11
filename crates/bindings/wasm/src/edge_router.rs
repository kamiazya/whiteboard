//! `routeEdge` over the routing wire, for QR-21 layer 1: canvas-render's
//! `layout/edges` suites, scoreboards included, run against the Rust router
//! through `test-utils/wasm/edge-router.ts` (ADR-0054 step 5). One call per
//! edge, which is the spike's measured-slow shape and a test surface only:
//! the layout will cross the wire once.

use crate::edge_primitives::{count, points_len_of};
use crate::routing_wire::{Malformed, Wire, side_index, side_of};
use whiteboard_edge_routing::edge_router::{RouteRequest, RoutingStyle, route_edge};
use whiteboard_edge_routing::edge_sides::EdgeAnchorPair;
use whiteboard_edge_routing::geometry::Rect;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::Arrowhead;

pub(crate) fn rects(wire: &mut Wire<'_>, n: usize) -> Option<Vec<Rect>> {
    (0..n)
        .map(|_| {
            let (x, y) = (wire.number()?, wire.number()?);
            Some(Rect { x, y, w: wire.number()?, h: wire.number()? })
        })
        .collect()
}

/// The anchors, `None` inside when unset; `Err` when the wire runs out.
fn anchors(wire: &mut Wire<'_>) -> Result<Option<EdgeAnchorPair>, Malformed> {
    let set = wire.number().ok_or(Malformed)? != 0.0;
    let pair = EdgeAnchorPair {
        from: wire.flagged_point()?,
        to: wire.flagged_point()?,
        from_lane_depth: wire.flagged_number()?,
        to_lane_depth: wire.flagged_number()?,
        from_side: side_of(wire.number().ok_or(Malformed)?),
        to_side: side_of(wire.number().ok_or(Malformed)?),
        around: wire.number().ok_or(Malformed)? != 0.0,
    };
    Ok(set.then_some(pair))
}

/// The style by its wire number: 0 straight, 1 orthogonal, 2 curved.
pub(crate) fn style_of(n: f64) -> Option<RoutingStyle> {
    match n {
        0.0 => Some(RoutingStyle::Straight),
        1.0 => Some(RoutingStyle::Orthogonal),
        2.0 => Some(RoutingStyle::Curved),
        _ => None,
    }
}

/// `routeEdge` of the wire's one edge.
///
/// In: the routing wire's nodes and exactly one edge, then the style (0
/// straight, 1 orthogonal, 2 curved); the anchors as a set flag, the from and
/// to anchor and lane depth (each a set flag then its value, a point as x, y),
/// the from and to side index (-1 for none) and around 0/1; `others` as a
/// count (-1 for absent) and that many rects; the budget's grid account as a
/// set flag then its value; and the labels as a count and rects. Out: `[grid
/// spent, rounded 0/1, from side, to side, from end, to end (0 none, 1
/// arrow), point count, then x, y per point]`; an empty array for a
/// malformed input.
#[cfg_attr(feature = "oracle-surface", wasm_bindgen::prelude::wasm_bindgen)]
#[must_use]
pub fn edge_route_edge(input: &[f64]) -> Vec<f64> {
    let decoded = (|| {
        let mut wire = Wire::new(input);
        let nodes = wire.nodes()?;
        let edge = match wire.edges()?.as_slice() {
            [edge] => edge.clone(),
            _ => return None,
        };
        let style = style_of(wire.number()?)?;
        let anchors = anchors(&mut wire).ok()?;
        let others = match wire.number()? {
            -1.0 => None,
            n => Some(rects(&mut wire, count(n)?)?),
        };
        let grid = wire.flagged_number().ok()?;
        let label_count = count(wire.number()?)?;
        let labels = rects(&mut wire, label_count)?;
        wire.is_done().then_some((nodes, edge, style, anchors, others, grid, labels))
    })();
    let Some((nodes, edge, style, anchors, others, grid, labels)) = decoded else {
        return Vec::new();
    };
    let mut budget = grid.map(|g| RoutingBudget { grid: g, ..RoutingBudget::for_layout() });
    let before = budget.map_or(0.0, |b| b.grid);
    let request = RouteRequest {
        anchors: anchors.as_ref(),
        others: others.as_deref(),
        budget: budget.as_mut(),
        labels: &labels,
    };
    let routed = route_edge(&nodes, &edge, style, request);
    // An unbounded account spends nothing it can count: Infinity minus
    // Infinity is NaN, where the TypeScript leaves the account at Infinity.
    let spent = budget.map_or(0.0, |b| if before.is_finite() { before - b.grid } else { 0.0 });
    let end = |a: Arrowhead| if a == Arrowhead::Arrow { 1.0 } else { 0.0 };
    let mut out = vec![
        spent,
        if routed.rounded { 1.0 } else { 0.0 },
        side_index(routed.from_side),
        side_index(routed.to_side),
        end(routed.from_end),
        end(routed.to_end),
        points_len_of(routed.path.len()),
    ];
    out.extend(routed.path.iter().flat_map(|p| [p.x, p.y]));
    out
}
