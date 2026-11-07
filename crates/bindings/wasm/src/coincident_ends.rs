//! The coincident-ends repair over the routing wire, for the layer-2
//! differential that holds it to `anchorsWithoutCoincidentEnds` (ADR-0054
//! step 5, QR-21 layer 2). A test surface like [`crate::edge_anchors`].

use crate::edge_anchors::{entry_values, pin, sides};
use crate::edge_primitives::{count, points_len_of};
use crate::edge_router::{rects, style_of};
use crate::routing_wire::Wire;
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_edge_routing::coincident_ends::{
    CoincidentRequest, anchors_without_coincident_ends,
};
use whiteboard_edge_routing::edge_router::RoutingStyle;
use whiteboard_edge_routing::edge_rules::SidePair;
use whiteboard_edge_routing::edge_sides::EdgeAnchorOverride;
use whiteboard_edge_routing::geometry::Rect;
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::{EdgeId, RoutableEdge, RoutingNode};

/// The wire's nodes, edges, side map, align, pins, styles, labels and budget.
type Decoded = (
    Vec<RoutingNode>,
    Vec<RoutableEdge>,
    JsMap<EdgeId, SidePair>,
    bool,
    JsMap<EdgeId, EdgeAnchorOverride>,
    Vec<RoutingStyle>,
    Vec<Rect>,
    RoutingBudget,
);

fn decode(input: &[f64]) -> Option<Decoded> {
    let mut wire = Wire::new(input);
    let (nodes, edges) = (wire.nodes()?, wire.edges()?);
    let side_map = sides(&mut wire)?;
    let align = wire.number()? != 0.0;
    let pin_count = count(wire.number()?)?;
    let pins: JsMap<EdgeId, EdgeAnchorOverride> =
        (0..pin_count).map(|_| pin(&mut wire).ok()).collect::<Option<_>>()?;
    let styles: Vec<RoutingStyle> =
        (0..edges.len()).map(|_| style_of(wire.number()?)).collect::<Option<_>>()?;
    let label_count = count(wire.number()?)?;
    let labels = rects(&mut wire, label_count)?;
    let budget = RoutingBudget {
        grid: wire.number()?,
        pairs: wire.number()?,
        trials: wire.number()?,
        repairs: wire.number()?,
    };
    wire.is_done().then_some((nodes, edges, side_map, align, pins, styles, labels, budget))
}

/// `anchorsWithoutCoincidentEnds`.
///
/// In: the routing wire's nodes and edges; the side map, align and the pins
/// as `edge_compute_anchors` reads them; one style per edge (0 straight, 1
/// orthogonal, 2 curved); the labels as a count and rects; and the budget's
/// grid, pairs, trials and repairs. Out: `[the four accounts left, entry
/// count, then 14 numbers an entry as edge_compute_anchors answers]`; an
/// empty array for a malformed input.
#[wasm_bindgen]
#[must_use]
pub fn edge_repair_coincident(input: &[f64]) -> Vec<f64> {
    let decoded = decode(input);
    let Some((nodes, edges, side_map, align, pins, styles, labels, mut budget)) = decoded else {
        return Vec::new();
    };
    // A style per edge by position; the TypeScript's styleOf is keyed by the edge.
    let style_of = |edge: &RoutableEdge| {
        edges
            .iter()
            .position(|e| std::ptr::eq(e, edge))
            .and_then(|i| styles.get(i).copied())
            .unwrap_or(RoutingStyle::Straight)
    };
    let request = CoincidentRequest {
        labels: &labels,
        style_of: &style_of,
        align,
        pins: (!pins.is_empty()).then_some(&pins),
    };
    let anchors = anchors_without_coincident_ends(&nodes, &edges, &side_map, &request, &mut budget);
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
