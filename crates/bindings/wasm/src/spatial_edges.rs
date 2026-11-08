//! The side-choice search over the routing wire, for the layer-2
//! differential that holds it to `assignEdgeAnchors` (ADR-0054 step 5,
//! QR-21 layer 2). A test surface like [`crate::edge_anchors`].

use crate::edge_anchors::{entry_values, pin};
use crate::edge_primitives::{count, points_len_of};
use crate::edge_router::{rects, style_of};
use crate::routing_wire::{Wire, side_index};
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_edge_routing::edge_router::RoutingStyle;
use whiteboard_edge_routing::edge_sides::EdgeAnchorOverride;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::layout_routes::route_layout;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::{
    Arrowhead, EdgeId, RoutableEdge, RoutingEnd, RoutingNode,
};
use whiteboard_edge_routing::spatial_edges::assign_edge_anchors;

/// The wire's nodes, edges, styles, overrides, labels and budget.
type Decoded = (
    Vec<RoutingNode>,
    Vec<RoutableEdge>,
    Vec<RoutingStyle>,
    Option<JsMap<EdgeId, EdgeAnchorOverride>>,
    Vec<Rect>,
    RoutingBudget,
);

/// The most numbers a routing wire may hold: `maxBytes` of this export's entry
/// in `crates/input-caps.json` (256 KiB) over eight bytes a number. The
/// largest wire the routing corpus and bench boards produce is 2,873 numbers
/// (23 KB, a 144-node, 165-edge board), so the cap is about eleven times
/// that, a board of roughly 2,000 edges. A longer input is refused as
/// malformed, and the shim then answers from the TypeScript.
pub const MAX_WIRE_NUMBERS: usize = 32_768;

fn decode(input: &[f64]) -> Option<Decoded> {
    if input.len() > MAX_WIRE_NUMBERS {
        return None;
    }
    let mut wire = Wire::new(input);
    let (nodes, edges) = (wire.nodes()?, wire.edges()?);
    let styles: Vec<RoutingStyle> =
        (0..edges.len()).map(|_| style_of(wire.number()?)).collect::<Option<_>>()?;
    let overrides = if wire.number()? == 0.0 {
        None
    } else {
        let n = count(wire.number()?)?;
        Some((0..n).map(|_| pin(&mut wire).ok()).collect::<Option<_>>()?)
    };
    let label_count = count(wire.number()?)?;
    let labels = rects(&mut wire, label_count)?;
    let budget = RoutingBudget {
        grid: wire.number()?,
        pairs: wire.number()?,
        trials: wire.number()?,
        repairs: wire.number()?,
    };
    if !wire.is_done() || !all_finite(&nodes, &edges, overrides.as_ref(), &labels, &budget) {
        return None;
    }
    Some((nodes, edges, styles, overrides, labels, budget))
}

fn point_is_finite(p: Point) -> bool {
    p.x.is_finite() && p.y.is_finite()
}

fn rect_is_finite(r: &Rect) -> bool {
    [r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite())
}

fn end_is_finite(end: &RoutingEnd) -> bool {
    match end {
        RoutingEnd::Node { .. } => true,
        RoutingEnd::Point { point, .. } => point_is_finite(*point),
    }
}

fn override_is_finite(o: &EdgeAnchorOverride) -> bool {
    o.from.is_none_or(point_is_finite)
        && o.to.is_none_or(point_is_finite)
        && o.from_lane_depth.is_none_or(f64::is_finite)
        && o.to_lane_depth.is_none_or(f64::is_finite)
}

/// Every number the routing reads as a position, size or allowance is finite.
///
/// The TypeScript's model admits only finite numbers there, and a NaN that
/// reaches the search makes its cost tuples incomparable: std's sort panics on
/// a comparator that is not a total order, which in the wasm build is an
/// aborted instance. A NaN in an end's unused slot is the wire's own
/// placeholder and never reaches here.
fn all_finite(
    nodes: &[RoutingNode],
    edges: &[RoutableEdge],
    overrides: Option<&JsMap<EdgeId, EdgeAnchorOverride>>,
    labels: &[Rect],
    budget: &RoutingBudget,
) -> bool {
    nodes.iter().all(|n| rect_is_finite(&n.rect))
        && edges.iter().all(|e| {
            end_is_finite(&e.from)
                && end_is_finite(&e.to)
                && e.bends.as_ref().is_none_or(|b| b.iter().all(|p| point_is_finite(*p)))
        })
        && overrides.is_none_or(|m| m.iter().all(|(_, o)| override_is_finite(o)))
        && labels.iter().all(rect_is_finite)
        && [budget.grid, budget.pairs, budget.trials, budget.repairs].iter().all(|v| v.is_finite())
}

/// `assignEdgeAnchors`.
///
/// In: the routing wire's nodes and edges; one style per edge (0 straight,
/// 1 orthogonal, 2 curved); the side overrides as a presence flag, then a
/// count and per override what `edge_compute_anchors` reads for a pin; the
/// labels as a count and rects; and the budget's grid, pairs, trials and
/// repairs. Out: `[the four accounts left, entry count, then 14 numbers an
/// entry as edge_compute_anchors answers]`; an empty array for a malformed
/// input.
#[wasm_bindgen]
#[must_use]
pub fn edge_assign_anchors(input: &[f64]) -> Vec<f64> {
    let Some((nodes, edges, styles, overrides, labels, mut budget)) = decode(input) else {
        return Vec::new();
    };
    let anchors =
        assign_edge_anchors((&nodes, &labels), (&edges, &styles), overrides.as_ref(), &mut budget);
    let mut out = vec![
        budget.grid,
        budget.pairs,
        budget.trials,
        budget.repairs,
        points_len_of(anchors.len()),
    ];
    for (id, entry) in anchors.iter() {
        out.extend(entry_values(*id, entry));
    }
    out
}

/// One layout's edge routing in one call: `assignEdgeAnchors`, then
/// `routeEdge` of every edge between its anchors on the same budget, as
/// canvas-render's composer runs them.
///
/// In: what `edge_assign_anchors` reads. Out: `[the four accounts left, edge
/// count, then per edge in input order: rounded 0/1, from side, to side,
/// from end, to end (0 none, 1 arrow), point count, then x, y per point;
/// then the anchors as `edge_assign_anchors` answers them after its
/// accounts: an entry count and 14 numbers an entry]`; an empty array for a
/// malformed input.
#[wasm_bindgen]
#[must_use]
pub fn edge_route_layout(input: &[f64]) -> Vec<f64> {
    let Some((nodes, edges, styles, overrides, labels, mut budget)) = decode(input) else {
        return Vec::new();
    };
    let (anchors, routed) =
        route_layout((&nodes, &labels), (&edges, &styles), overrides.as_ref(), &mut budget);
    let end = |a: Arrowhead| if a == Arrowhead::Arrow { 1.0 } else { 0.0 };
    let mut out =
        vec![budget.grid, budget.pairs, budget.trials, budget.repairs, points_len_of(routed.len())];
    for edge in &routed {
        out.extend([
            if edge.rounded { 1.0 } else { 0.0 },
            side_index(edge.from_side),
            side_index(edge.to_side),
            end(edge.from_end),
            end(edge.to_end),
            points_len_of(edge.path.len()),
        ]);
        out.extend(edge.path.iter().flat_map(|p| [p.x, p.y]));
    }
    out.push(points_len_of(anchors.len()));
    for (id, entry) in anchors.iter() {
        out.extend(entry_values(*id, entry));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{MAX_WIRE_NUMBERS, edge_route_layout};

    /// A wire of `nodes` unit nodes, no edges, no overrides, `labels` rects
    /// and the layout's budget: `8 + 5 * nodes + 4 * labels` numbers.
    fn wire(nodes: usize, labels: usize) -> Vec<f64> {
        let mut w = vec![f64::from(u32::try_from(nodes).unwrap_or(0))];
        for id in 0..nodes {
            w.extend([f64::from(u32::try_from(id).unwrap_or(0)), 0.0, 0.0, 1.0, 1.0]);
        }
        w.extend([0.0, 0.0, f64::from(u32::try_from(labels).unwrap_or(0))]);
        w.extend(std::iter::repeat_n(0.0, 4 * labels));
        w.extend([64e6, 64e6, 200e6, 1e6]);
        w
    }

    #[test]
    fn a_wire_at_the_cap_is_answered_and_one_number_over_is_refused() {
        let at_cap = wire(4, 8_185);
        let over = wire(1, 8_189);
        assert_eq!((at_cap.len(), over.len()), (MAX_WIRE_NUMBERS, MAX_WIRE_NUMBERS + 1));
        assert!(!edge_route_layout(&at_cap).is_empty());
        assert!(edge_route_layout(&over).is_empty());
    }

    #[test]
    fn counts_far_past_the_wire_are_refused_without_allocating_for_them() {
        for huge in [1e8, 9e8, 1e9 - 1.0] {
            // A count of nodes, edges or labels that the rest of the wire
            // cannot hold: the decode stops at the first missing number.
            assert!(edge_route_layout(&[huge]).is_empty());
            assert!(edge_route_layout(&[0.0, huge]).is_empty());
            let mut labels = wire(0, 0);
            labels[3] = huge;
            assert!(edge_route_layout(&labels).is_empty());
        }
    }

    #[test]
    fn non_finite_and_negative_counts_are_refused() {
        for bad in [f64::NAN, f64::INFINITY, -1.0, 0.5, 1e9] {
            assert!(edge_route_layout(&[bad]).is_empty());
            assert!(edge_route_layout(&[0.0, bad]).is_empty());
        }
    }

    /// A wire of two nodes (ids 0 and 1), one edge from node 0 to the free
    /// point (50, 5) through the bend (30, 5), and one label, with the layout's
    /// budget. Each `at` below indexes a number the routing reads as geometry
    /// or allowance.
    fn board() -> Vec<f64> {
        vec![
            2.0,
            0.0,
            0.0,
            0.0,
            10.0,
            10.0,
            1.0,
            40.0,
            0.0,
            10.0,
            10.0, // nodes
            1.0,
            7.0, // one edge, id 7
            0.0,
            0.0,
            f64::NAN,
            1.0,
            1.0, // from node 0, right side, arrow
            1.0,
            50.0,
            5.0,
            -1.0,
            0.0, // to the free point (50, 5)
            1.0,
            30.0,
            5.0, // one bend
            1.0, // style: orthogonal
            0.0, // no overrides
            1.0,
            0.0,
            20.0,
            10.0,
            4.0, // one label
            64e6,
            64e6,
            200e6,
            1e6,
        ]
    }

    #[test]
    fn a_board_with_every_position_finite_is_answered() {
        assert!(!edge_route_layout(&board()).is_empty());
    }

    #[test]
    fn a_non_finite_position_size_or_allowance_is_refused() {
        // node 0's height, node 1's x, the free end's x, the bend's y, the
        // label's width, and each of the budget's four accounts
        for at in [5, 7, 19, 25, 31, 33, 34, 35, 36] {
            for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                let mut w = board();
                w[at] = bad;
                assert!(edge_route_layout(&w).is_empty(), "{bad} at {at} was answered");
            }
        }
    }
}
