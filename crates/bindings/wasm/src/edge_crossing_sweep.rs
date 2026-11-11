//! The crossing sweep over flat arrays, for the layer-2 differential that
//! holds it to canvas-render's `edge-crossing-sweep.ts` (ADR-0054 step 5,
//! QR-21 layer 2). A test surface like [`crate::edge_router_leaves`].

use crate::edge_primitives::{count, points_len_of};
use crate::routing_wire::Wire;
use whiteboard_edge_routing::edge_crossing_sweep::{build_pairwise_scores, shared_corners};
use whiteboard_edge_routing::geometry::Point;
use whiteboard_edge_routing::routing_budget::RoutingBudget;

fn paths(wire: &mut Wire<'_>) -> Option<Vec<Vec<Point>>> {
    let n = count(wire.number()?)?;
    (0..n)
        .map(|_| {
            let len = count(wire.number()?)?;
            (0..len).map(|_| wire.point()).collect()
        })
        .collect()
}

/// `buildPairwiseScores`, then `sharedCorners` of every ordered pair.
///
/// In: a path count and per path a point count and x, y per point; then the
/// pairs account as a set flag and its value. Out: `[pairs left (0 when
/// unset), built 0/1, entry count, then key, overlap, illegible, crossings
/// per entry in Map order, then sharedCorners(a, b) for every a, b in
/// order]`; an empty array for a malformed input.
#[cfg_attr(feature = "oracle-surface", wasm_bindgen::prelude::wasm_bindgen)]
#[must_use]
pub fn edge_pairwise_scores(input: &[f64]) -> Vec<f64> {
    let decoded = (|| {
        let mut wire = Wire::new(input);
        let paths = paths(&mut wire)?;
        let pairs = wire.flagged_number().ok()?;
        wire.is_done().then_some((paths, pairs))
    })();
    let Some((paths, pairs)) = decoded else { return Vec::new() };
    let mut budget = pairs.map(|p| RoutingBudget { pairs: p, ..RoutingBudget::for_layout() });
    let scores = build_pairwise_scores(&paths, budget.as_mut());
    let mut out = vec![budget.map_or(0.0, |b| b.pairs)];
    match scores {
        None => out.extend([0.0, 0.0]),
        Some(scores) => {
            out.extend([1.0, points_len_of(scores.len())]);
            for (key, triple) in scores.iter() {
                out.push(points_len_of(*key));
                out.extend(triple);
            }
        }
    }
    for a in &paths {
        out.extend(paths.iter().map(|b| shared_corners(a, b)));
    }
    out
}
