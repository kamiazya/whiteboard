//! The side-choice search over the routing wire, for the layer-2
//! differential that holds it to `assignEdgeAnchors` (ADR-0054 step 5,
//! QR-21 layer 2). A test surface like [`crate::edge_anchors`].

use crate::edge_anchors::{entry_values, pin};
use crate::edge_primitives::{count, points_len_of};
use crate::edge_router::{rects, style_of};
use crate::routing_wire::Wire;
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_edge_routing::edge_router::RoutingStyle;
use whiteboard_edge_routing::edge_sides::EdgeAnchorOverride;
use whiteboard_edge_routing::geometry::Rect;
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::{EdgeId, RoutableEdge, RoutingNode};
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

fn decode(input: &[f64]) -> Option<Decoded> {
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
    wire.is_done().then_some((nodes, edges, styles, overrides, labels, budget))
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
