//! Concrete answers of the ink measures that cargo-mutants showed no other
//! test pinned. Every expected value is what canvas-render's `edge-ink.ts`
//! returns for the same input.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::edge_ink::{ink_along_rects, self_retraced_ink, tunnelled_ink};
use whiteboard_edge_routing::geometry::{Point, Rect};

const fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

/// An overlap that is empty at infinity adds nothing: `inf - inf` is NaN,
/// so only a strictly positive overlap may be summed.
#[test]
fn an_empty_overlap_at_infinity_adds_no_ink() {
    let to_infinity = [p(0.0, 0.0), p(f64::INFINITY, 0.0)];
    let at_infinity = Rect { x: f64::INFINITY, y: 0.0, w: 0.0, h: 0.0 };
    assert_eq!(
        ink_along_rects(&to_infinity, &[at_infinity], |_, _, _| true).to_bits(),
        0.0_f64.to_bits()
    );

    let through = [p(0.0, 5.0), p(f64::INFINITY, 5.0)];
    let body = Rect { x: f64::INFINITY, y: 0.0, w: 0.0, h: 10.0 };
    assert_eq!(tunnelled_ink(&through, &[body]).to_bits(), 0.0_f64.to_bits());

    let retraced = [p(0.0, 0.0), p(f64::INFINITY, 0.0), p(f64::INFINITY, 0.0)];
    assert_eq!(self_retraced_ink(&retraced).to_bits(), 0.0_f64.to_bits());
}
