//! The wasm-bindgen composition root: what the browser and Node load.
//!
//! Its export surface is coarse and JSON-shaped; the TypeScript shim built
//! from the same commit checks [`abi_version`] at init and refuses an
//! artifact whose surface it was not written against.

use wasm_bindgen::prelude::wasm_bindgen;

pub mod coincident_ends;
pub mod edge_anchors;
pub mod edge_crossing_sweep;
pub mod edge_primitives;
pub mod edge_router;
pub mod edge_router_leaves;
pub mod edge_rules;
#[path = "generated/input_caps.rs"]
pub mod input_caps;
pub mod okf;
pub mod okf_wire;
pub mod routing_wire;
pub mod spatial_edges;

/// Identifies the exported surface. Change it whenever an export is added,
/// removed or changes shape, so a stale artifact fails at init rather than
/// on its first mismatched call.
pub const ABI_VERSION: &str = "16";

/// The ABI identifier the shim compares against its own.
#[wasm_bindgen]
#[must_use]
pub fn abi_version() -> String {
    ABI_VERSION.to_owned()
}

/// `det::math::hypot` over two arrays, one answer per index.
///
/// The det exports are batched rather than one call per number (QR-22b): the
/// property differential that holds them to canvas-render's `det-math.ts`
/// crosses the boundary once per run. An index past the shorter array has
/// no answer, so the caller passes arrays of one length.
#[wasm_bindgen]
#[must_use]
pub fn det_hypot(dx: &[f64], dy: &[f64]) -> Vec<f64> {
    dx.iter().zip(dy).map(|(&x, &y)| whiteboard_det::math::hypot(x, y)).collect()
}

/// `det::math::sin` over an array; see [`det_hypot`].
#[wasm_bindgen]
#[must_use]
pub fn det_sin(xs: &[f64]) -> Vec<f64> {
    xs.iter().map(|&x| whiteboard_det::math::sin(x)).collect()
}

/// `det::math::cos` over an array; see [`det_hypot`].
#[wasm_bindgen]
#[must_use]
pub fn det_cos(xs: &[f64]) -> Vec<f64> {
    xs.iter().map(|&x| whiteboard_det::math::cos(x)).collect()
}

/// `route_on_grid` over one flat array, the routing spike's boundary
/// (ADR-0054 step 5).
///
/// In: `[start.x, start.y, end.x, end.y, clearance, allowance, then x, y, w,
/// h per obstacle]`, with `allowance` infinite when the caller has no
/// budget. Out: `[spent, then x, y per point of the route]`, so a length of
/// one means no route. Typed arrays rather than JSON: this is called once
/// per edge, which puts it in ADR-0054's declared fast-path class, and the
/// spike measures what that boundary costs. A malformed input answers no
/// route and spends nothing.
#[wasm_bindgen]
#[must_use]
pub fn edge_route_on_grid(input: &[f64]) -> Vec<f64> {
    use whiteboard_edge_routing::geometry::{Point, Rect};
    let ([sx, sy, ex, ey, clearance, allowance], rest) = match input.split_first_chunk::<6>() {
        Some((head, rest)) if rest.len() % 4 == 0 => (*head, rest),
        _ => return vec![0.0],
    };
    let obstacles: Vec<Rect> =
        rest.chunks_exact(4).map(|r| Rect { x: r[0], y: r[1], w: r[2], h: r[3] }).collect();
    let route = whiteboard_edge_routing::grid_route::route_on_grid(
        Point { x: sx, y: sy },
        Point { x: ex, y: ey },
        &obstacles,
        clearance,
        allowance,
    );
    let mut out = vec![route.spent];
    if let Some(path) = route.path {
        out.extend(path.iter().flat_map(|p| [p.x, p.y]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{ABI_VERSION, abi_version, det_cos, det_hypot, det_sin, edge_route_on_grid};

    #[test]
    fn the_grid_export_flattens_the_route_and_refuses_a_malformed_input() {
        let straight = edge_route_on_grid(&[0.0, 0.0, 100.0, 0.0, 16.0, f64::INFINITY]);
        assert_eq!(straight, vec![0.0, 0.0, 0.0, 100.0, 0.0]);
        assert_eq!(edge_route_on_grid(&[0.0, 0.0]), vec![0.0]);
        assert_eq!(edge_route_on_grid(&[0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 5.0]), vec![0.0]);
    }

    #[test]
    fn the_det_exports_answer_each_input_in_order() {
        assert_eq!(det_hypot(&[3.0, 5.0], &[4.0, 12.0]), vec![5.0, 13.0]);
        assert_eq!(
            det_sin(&[0.0, -0.0]).iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
            vec![0, 1 << 63]
        );
        assert_eq!(det_cos(&[0.0]), vec![1.0]);
        assert_eq!(det_hypot(&[3.0, 1.0], &[4.0]), vec![5.0]);
    }

    #[test]
    fn exports_the_declared_abi_version() {
        assert_eq!(abi_version(), ABI_VERSION);
    }
}
