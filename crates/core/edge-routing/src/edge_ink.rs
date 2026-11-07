//! How an edge's ink is measured: canvas-render's `layout/edges/edge-ink.ts`
//! and `diagonal-ink.ts`, ported function for function.
//!
//! Every term but the diagonal one is in the `COST_QUANTUM`-quantized space,
//! so it is integral by construction. Rust works for the same answer in two
//! places: `quantize` is `Math.round`, which is not `f64::round`
//! ([`js_round`]), and `Math.min`/`Math.max` are [`js_min`]/[`js_max`].

#![expect(clippy::float_cmp, reason = "the TypeScript compares coordinates with ===")]

use crate::geometry::{Point, Rect};
use whiteboard_det::math::{hypot, js_max, js_min, js_round};

/// Quarter-pixel quantization, as `COST_QUANTUM` in edge-ink.ts.
pub const COST_QUANTUM: f64 = 4.0;

#[must_use]
pub fn quantize(n: f64) -> f64 {
    js_round(n * COST_QUANTUM)
}

/// An axis-aligned segment's orientation, as `SegmentAxis` in edge-ink.ts.
#[derive(Clone, Copy)]
enum Axis {
    Horizontal,
    Vertical,
}

impl Axis {
    /// `None` for a diagonal or zero-length segment.
    fn of(a: Point, b: Point) -> Option<Self> {
        if a.y == b.y && a.x != b.x {
            Some(Self::Horizontal)
        } else if a.x == b.x && a.y != b.y {
            Some(Self::Vertical)
        } else {
            None
        }
    }

    const fn along(self, p: Point) -> f64 {
        match self {
            Self::Horizontal => p.x,
            Self::Vertical => p.y,
        }
    }

    const fn across(self, p: Point) -> f64 {
        match self {
            Self::Horizontal => p.y,
            Self::Vertical => p.x,
        }
    }

    /// A rect's near and far edges ALONG the segment.
    fn along_edges(self, r: Rect) -> (f64, f64) {
        match self {
            Self::Horizontal => (r.x, r.x + r.w),
            Self::Vertical => (r.y, r.y + r.h),
        }
    }

    /// Its near and far edges ACROSS the segment.
    fn across_edges(self, r: Rect) -> (f64, f64) {
        match self {
            Self::Horizontal => (r.y, r.y + r.h),
            Self::Vertical => (r.x, r.x + r.w),
        }
    }
}

/// Each axis-aligned segment of `path` with its orientation.
fn axis_segments(path: &[Point]) -> impl Iterator<Item = (Axis, Point, Point)> + '_ {
    path.windows(2).filter_map(|pair| match pair {
        [a, b] => Axis::of(*a, *b).map(|axis| (axis, *a, *b)),
        _ => None,
    })
}

/// Quantized ink of `path`'s axis-aligned segments lying along `rects`,
/// where `qualifies(fixed, near, far)` decides from the quantized fixed
/// coordinate and the rect's two quantized borders across it whether a
/// segment counts.
pub fn ink_along_rects(
    path: &[Point],
    rects: &[Rect],
    qualifies: impl Fn(f64, f64, f64) -> bool,
) -> f64 {
    let mut total = 0.0;
    for (axis, a, b) in axis_segments(path) {
        let fixed = quantize(axis.across(a));
        let (p1, p2) = (axis.along(a), axis.along(b));
        for &r in rects {
            let (near_across, far_across) = axis.across_edges(r);
            if !qualifies(fixed, quantize(near_across), quantize(far_across)) {
                continue;
            }
            let (near_along, far_along) = axis.along_edges(r);
            let lo = js_max(quantize(js_min(p1, p2)), quantize(near_along));
            let hi = js_min(quantize(js_max(p1, p2)), quantize(far_along));
            if hi > lo {
                total += hi - lo;
            }
        }
    }
    total
}

/// border-tracing's predicate in edge-rules.ts: on either border.
#[must_use]
pub fn on_either_border(fixed: f64, near: f64, far: f64) -> bool {
    fixed == near || fixed == far
}

/// endpoint-body-ink's predicate in edge-rules.ts: strictly between the borders.
#[must_use]
pub fn strictly_between(fixed: f64, near: f64, far: f64) -> bool {
    near < fixed && fixed < far
}

/// Quantized ink of axis-aligned segments through a bystander's body, the
/// segment's fixed coordinate STRICTLY inside the body's other axis.
#[must_use]
pub fn tunnelled_ink(path: &[Point], foreign_bodies: &[Rect]) -> f64 {
    let mut ink = 0.0;
    for (axis, a, b) in axis_segments(path) {
        let fixed = axis.across(a);
        let (p1, p2) = (axis.along(a), axis.along(b));
        for &r in foreign_bodies {
            let (near_across, far_across) = axis.across_edges(r);
            if fixed <= near_across || fixed >= far_across {
                continue;
            }
            let (near_along, far_along) = axis.along_edges(r);
            let lo = js_max(js_min(p1, p2), near_along);
            let hi = js_min(js_max(p1, p2), far_along);
            if hi > lo {
                ink += quantize(hi - lo);
            }
        }
    }
    ink
}

/// Quantized ink the path lays over itself, collinear overlap only, summed
/// over every segment pair in the TypeScript's order.
#[must_use]
pub fn self_retraced_ink(path: &[Point]) -> f64 {
    let quantized: Vec<(f64, f64)> = path.iter().map(|p| (quantize(p.x), quantize(p.y))).collect();
    let segments: Vec<((f64, f64), (f64, f64))> = quantized
        .windows(2)
        .filter_map(|pair| match pair {
            [a, b] => Some((*a, *b)),
            _ => None,
        })
        .collect();
    let mut ink = 0.0;
    for (i, &(a0, a1)) in segments.iter().enumerate() {
        for &(b0, b1) in segments.iter().skip(i).skip(1) {
            let vertical = collinear_overlap((a0.0, a1.0, b0.0, b1.0), (a0.1, a1.1, b0.1, b1.1));
            let horizontal = collinear_overlap((a0.1, a1.1, b0.1, b1.1), (a0.0, a1.0, b0.0, b1.0));
            ink += vertical + horizontal;
        }
    }
    ink
}

/// How far two segments overlap while sharing a line: `fixed` holds the
/// four ends' coordinate that must agree, `varying` the one measured in.
fn collinear_overlap(fixed: (f64, f64, f64, f64), varying: (f64, f64, f64, f64)) -> f64 {
    let (a0, a1, b0, b1) = fixed;
    if a0 != a1 || b0 != b1 || a0 != b0 {
        return 0.0;
    }
    let (va0, va1, vb0, vb1) = varying;
    let lo = js_max(js_min(va0, va1), js_min(vb0, vb1));
    let hi = js_min(js_max(va0, va1), js_max(vb0, vb1));
    if hi > lo { hi - lo } else { 0.0 }
}

/// The fraction of `a` -> `a + (dx, dy)` strictly inside `r`, by open
/// Liang-Barsky clipping.
fn inside_fraction(a: Point, dx: f64, dy: f64, r: Rect) -> f64 {
    let mut t0 = 0.0;
    let mut t1 = 1.0;
    for (p, q) in [(-dx, a.x - r.x), (dx, r.x + r.w - a.x), (-dy, a.y - r.y), (dy, r.y + r.h - a.y)]
    {
        let t = q / p;
        if p < 0.0 {
            t0 = js_max(t0, t);
        } else {
            t1 = js_min(t1, t);
        }
    }
    if t1 > t0 { t1 - t0 } else { 0.0 }
}

/// Raw length of `path`'s diagonal segments strictly inside `rects`.
#[must_use]
pub fn diagonal_ink_through(path: &[Point], rects: &[Rect]) -> f64 {
    let mut total = 0.0;
    for pair in path.windows(2) {
        let [a, b] = pair else { continue };
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        if dx == 0.0 || dy == 0.0 {
            continue;
        }
        let length = hypot(dx, dy);
        for &r in rects {
            total += inside_fraction(*a, dx, dy, r) * length;
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::{
        diagonal_ink_through, ink_along_rects, quantize, self_retraced_ink, tunnelled_ink,
    };
    use crate::geometry::{Point, Rect};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    const BOX: Rect = Rect { x: 0.0, y: 0.0, w: 10.0, h: 10.0 };

    #[test]
    fn quantize_rounds_a_half_quantum_up_as_math_round_does() {
        assert_eq!(quantize(0.125), 1.0);
        assert_eq!(quantize(-0.125), 0.0);
    }

    #[test]
    fn ink_along_a_border_and_through_a_body_is_quantized_length() {
        let along_top = [p(-5.0, 0.0), p(5.0, 0.0)];
        let on_border = |fixed: f64, near: f64, far: f64| fixed == near || fixed == far;
        assert_eq!(ink_along_rects(&along_top, &[BOX], on_border), 20.0);
        assert_eq!(tunnelled_ink(&[p(-5.0, 5.0), p(15.0, 5.0)], &[BOX]), 40.0);
        assert_eq!(tunnelled_ink(&along_top, &[BOX]), 0.0);
    }

    #[test]
    fn a_path_doubling_back_over_itself_retraces_the_overlap() {
        assert_eq!(self_retraced_ink(&[p(0.0, 0.0), p(10.0, 0.0), p(4.0, 0.0)]), 24.0);
        assert_eq!(self_retraced_ink(&[p(0.0, 0.0), p(10.0, 0.0), p(10.0, 5.0)]), 0.0);
    }

    #[test]
    fn a_diagonal_through_a_box_is_charged_its_chord_and_one_on_a_corner_nothing() {
        let through = diagonal_ink_through(&[p(-5.0, -5.0), p(15.0, 15.0)], &[BOX]);
        assert!((through - 200.0_f64.sqrt()).abs() < 1e-9);
        assert_eq!(diagonal_ink_through(&[p(-5.0, 5.0), p(5.0, -5.0)], &[BOX]), 0.0);
    }
}
