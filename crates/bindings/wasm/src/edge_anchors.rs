//! The anchor pass over the routing wire, for the layer-2 differential that
//! holds it to canvas-render's `edge-anchors.ts` (ADR-0054 step 5, QR-21
//! layer 2). A test surface like [`crate::edge_router_leaves`]: the layout's
//! one call will run it inside the side-choice search instead.

use crate::edge_primitives::{count, points_len_of};
use crate::routing_wire::{Malformed, Wire, side_index, side_of};
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_edge_routing::edge_anchors::{
    anchor_context, build_anchor_groups, compute_anchors_for, patch_anchor_groups, patch_work,
};
use whiteboard_edge_routing::edge_rules::SidePair;
use whiteboard_edge_routing::edge_sides::{EdgeAnchorOverride, EdgeAnchorPair};
use whiteboard_edge_routing::geometry::Point;
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::routing_input::EdgeId;

fn edge_id(wire: &mut Wire<'_>) -> Option<EdgeId> {
    count(wire.number()?).and_then(|n| u32::try_from(n).ok())
}

/// A side pair as `[from side, to side, around 0/1]`.
fn side_pair(wire: &mut Wire<'_>) -> Option<SidePair> {
    Some(SidePair {
        from_side: side_of(wire.number()?)?,
        to_side: side_of(wire.number()?)?,
        around: wire.number()? != 0.0,
    })
}

fn sides(wire: &mut Wire<'_>) -> Option<JsMap<EdgeId, SidePair>> {
    let n = count(wire.number()?)?;
    (0..n).map(|_| Some((edge_id(wire)?, side_pair(wire)?))).collect()
}

fn pin(wire: &mut Wire<'_>) -> Result<(EdgeId, EdgeAnchorOverride), Malformed> {
    let id = edge_id(wire).ok_or(Malformed)?;
    let sides = side_pair(wire).ok_or(Malformed)?;
    Ok((
        id,
        EdgeAnchorOverride {
            sides,
            from: wire.flagged_point()?,
            from_lane_depth: wire.flagged_number()?,
            to: wire.flagged_point()?,
            to_lane_depth: wire.flagged_number()?,
        },
    ))
}

fn flagged_point(p: Option<Point>) -> [f64; 3] {
    p.map_or([0.0, 0.0, 0.0], |p| [1.0, p.x, p.y])
}

fn flagged(v: Option<f64>) -> [f64; 2] {
    v.map_or([0.0, 0.0], |v| [1.0, v])
}

fn entry_values(id: EdgeId, e: &EdgeAnchorPair) -> impl Iterator<Item = f64> {
    let side = |s: Option<_>| s.map_or(-1.0, side_index);
    [f64::from(id)]
        .into_iter()
        .chain(flagged_point(e.from))
        .chain(flagged_point(e.to))
        .chain(flagged(e.from_lane_depth))
        .chain(flagged(e.to_lane_depth))
        .chain([side(e.from_side), side(e.to_side), if e.around { 1.0 } else { 0.0 }])
}

/// `computeAnchorsFor`, built from scratch or patched from a base.
///
/// In: the routing wire's nodes and edges; the side map as a count and per
/// entry `[edge id, from side, to side, around]`; align 0/1; the pins as a
/// count and per pin `[edge id, its side pair (3), from (a set flag, x, y),
/// from lane depth (a set flag, value), to, to lane depth]`; then `-1` for a
/// full build, or an edge index and the side pair it is re-sided to, which
/// patches `buildAnchorGroups` of the side map into the map with that edge
/// set. Out: `[patchWork (0 for a full build), entry count, then 14 numbers
/// an entry: edge id, from (flag, x, y), to, from lane depth (flag, value),
/// to lane depth, from side, to side (-1 for none), around]`; an empty
/// array for a malformed input.
#[wasm_bindgen]
#[must_use]
pub fn edge_compute_anchors(input: &[f64]) -> Vec<f64> {
    let decoded = (|| {
        let mut wire = Wire::new(input);
        let (nodes, edges) = (wire.nodes()?, wire.edges()?);
        let base_sides = sides(&mut wire)?;
        let align = wire.number()? != 0.0;
        let pin_count = count(wire.number()?)?;
        let pins: JsMap<EdgeId, EdgeAnchorOverride> =
            (0..pin_count).map(|_| pin(&mut wire).ok()).collect::<Option<_>>()?;
        let patch = match wire.number()? {
            -1.0 => None,
            i => Some((count(i)?, side_pair(&mut wire)?)),
        };
        wire.is_done().then_some((nodes, edges, base_sides, align, pins, patch))
    })();
    let Some((nodes, edges, base_sides, align, pins, patch)) = decoded else {
        return Vec::new();
    };
    let ctx = anchor_context(&nodes, &edges);
    let pins = (!pins.is_empty()).then_some(&pins);
    let (work, anchors) = match patch {
        None => (0, compute_anchors_for(&ctx, &base_sides, align, pins, None)),
        Some((index, pair)) => {
            let Some(edge) = edges.get(index) else { return Vec::new() };
            let mut next = base_sides.clone();
            next.set(edge.id, pair);
            let base = build_anchor_groups(&ctx, &base_sides);
            let work = patch_work(&ctx, &base, &next, index);
            let patched = patch_anchor_groups(&ctx, &base, &next, index);
            (work, compute_anchors_for(&ctx, &next, align, pins, Some(patched)))
        }
    };
    let mut out = vec![points_len_of(work), points_len_of(anchors.len())];
    for (id, entry) in anchors.iter() {
        out.extend(entry_values(*id, entry));
    }
    out
}
