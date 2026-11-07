//! The geometry vocabulary the edge layer is written in: canvas-render's
//! `layout/edges/edge-geometry.ts`, ported function for function.
//!
//! The reasoning behind each function is written once, in the TypeScript.
//! This file says only where Rust has to work to give the same answer:
//! `Math.min`/`Math.max` become [`js_min`]/[`js_max`], and every `===` on a
//! coordinate stays an exact comparison.
//!
//! `rectOf` and `rectAtEnd` are not here: they read model types
//! (`SpatialNode`, an edge's end), which this crate has no contract for yet.
//! They move with the model contract, and until then the TypeScript hands
//! the router rects.

#![expect(clippy::float_cmp, reason = "the TypeScript compares coordinates with ===")]

use crate::geometry::{Point, Rect};
use whiteboard_det::math::{hypot, js_max, js_min};

/// A node's side, as `EdgeSide` in the model names it.
///
/// Declared here rather than generated because the model's contract is not
/// emitted yet. ponytail: a local enum; it is replaced by the generated
/// `EdgeSide` when `whiteboard-model` lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Side {
    Top,
    Bottom,
    Left,
    Right,
}

#[must_use]
pub fn center_of(rect: Rect) -> Point {
    Point { x: rect.x + rect.w / 2.0, y: rect.y + rect.h / 2.0 }
}

/// Border-inclusive.
#[must_use]
pub fn contains_point(rect: Rect, point: Point) -> bool {
    point.x >= rect.x
        && point.x <= rect.x + rect.w
        && point.y >= rect.y
        && point.y <= rect.y + rect.h
}

#[must_use]
pub fn side_point(rect: Rect, side: Side) -> Point {
    match side {
        Side::Top => Point { x: rect.x + rect.w / 2.0, y: rect.y },
        Side::Bottom => Point { x: rect.x + rect.w / 2.0, y: rect.y + rect.h },
        Side::Left => Point { x: rect.x, y: rect.y + rect.h / 2.0 },
        Side::Right => Point { x: rect.x + rect.w, y: rect.y + rect.h / 2.0 },
    }
}

/// Strict interior: a point exactly on the border is not inside.
#[must_use]
pub fn strictly_inside(rect: Rect, point: Point) -> bool {
    point.x > rect.x && point.x < rect.x + rect.w && point.y > rect.y && point.y < rect.y + rect.h
}

/// y on vertical sides, x on horizontal ones.
#[must_use]
pub fn tangent_coordinate(side: Side, point: Point) -> f64 {
    match side {
        Side::Left | Side::Right => point.y,
        Side::Top | Side::Bottom => point.x,
    }
}

/// The point a fraction of the way along a side, 0 at its top/left end.
#[must_use]
pub fn side_point_at(rect: Rect, side: Side, fraction: f64) -> Point {
    match side {
        Side::Top => Point { x: rect.x + rect.w * fraction, y: rect.y },
        Side::Bottom => Point { x: rect.x + rect.w * fraction, y: rect.y + rect.h },
        Side::Left => Point { x: rect.x, y: rect.y + rect.h * fraction },
        Side::Right => Point { x: rect.x + rect.w, y: rect.y + rect.h * fraction },
    }
}

/// Whether segment `a`-`b` passes through `rect`'s interior, by the slab
/// method; touching a border does not count.
#[must_use]
pub fn segment_crosses_rect(a: Point, b: Point, rect: Rect) -> bool {
    let right = rect.x + rect.w;
    let bottom = rect.y + rect.h;
    if js_max(a.x, b.x) < rect.x
        || js_min(a.x, b.x) > right
        || js_max(a.y, b.y) < rect.y
        || js_min(a.y, b.y) > bottom
    {
        return false;
    }
    let mut enter = 0.0;
    let mut exit = 1.0;
    let axes: [(f64, f64, f64, f64); 2] = [(a.x, b.x, rect.x, right), (a.y, b.y, rect.y, bottom)];
    for (from, to, near_edge, far_edge) in axes {
        let d = to - from;
        let near = near_edge - from;
        let far = far_edge - from;
        if d == 0.0 {
            if near > 0.0 || far < 0.0 {
                return false;
            }
            continue;
        }
        let t0 = near / d;
        let t1 = far / d;
        enter = js_max(enter, js_min(t0, t1));
        exit = js_min(exit, js_max(t0, t1));
        if enter >= exit {
            return false;
        }
    }
    exit > enter
}

/// No segment of `path` crosses any obstacle's interior.
#[must_use]
pub fn path_is_clear(path: &[Point], obstacles: &[Rect]) -> bool {
    path.windows(2).all(|pair| match pair {
        [a, b] => obstacles.iter().all(|&rect| !segment_crosses_rect(*a, *b, rect)),
        _ => true,
    })
}

/// The smallest rect holding every one, or `None` for none.
#[must_use]
pub fn union_rect(rects: &[Rect]) -> Option<Rect> {
    let (first, rest) = rects.split_first()?;
    let mut min_x = first.x;
    let mut min_y = first.y;
    let mut max_x = first.x + first.w;
    let mut max_y = first.y + first.h;
    for rect in rest {
        min_x = js_min(min_x, rect.x);
        min_y = js_min(min_y, rect.y);
        max_x = js_max(max_x, rect.x + rect.w);
        max_y = js_max(max_y, rect.y + rect.h);
    }
    Some(Rect { x: min_x, y: min_y, w: max_x - min_x, h: max_y - min_y })
}

/// The polyline's length, summed segment by segment from the first.
#[must_use]
pub fn path_length(path: &[Point]) -> f64 {
    path.windows(2).fold(0.0, |total, pair| match pair {
        [a, b] => total + hypot(b.x - a.x, b.y - a.y),
        _ => total,
    })
}

/// The direction a side faces, away from the node's interior.
#[must_use]
pub fn outward_normal(side: Side) -> Point {
    match side {
        Side::Top => Point { x: 0.0, y: -1.0 },
        Side::Bottom => Point { x: 0.0, y: 1.0 },
        Side::Left => Point { x: -1.0, y: 0.0 },
        Side::Right => Point { x: 1.0, y: 0.0 },
    }
}

/// Drops a point equal to the one before it in the INPUT (not in the
/// output), as the TypeScript's `filter` does.
#[must_use]
pub fn without_repeats(path: &[Point]) -> Vec<Point> {
    let mut out: Vec<Point> = path.first().copied().into_iter().collect();
    out.extend(path.windows(2).filter_map(|pair| match pair {
        [prev, point] if point.x != prev.x || point.y != prev.y => Some(*point),
        _ => None,
    }));
    out
}

/// Axis-aligned bounds of a point set. Compares with `<`/`>`, so a NaN
/// coordinate never moves a bound, and an empty set answers the infinite
/// inverted box the TypeScript does.
#[must_use]
pub fn bounding_box_of(points: &[Point]) -> Rect {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for point in points {
        if point.x < min_x {
            min_x = point.x;
        }
        if point.x > max_x {
            max_x = point.x;
        }
        if point.y < min_y {
            min_y = point.y;
        }
        if point.y > max_y {
            max_y = point.y;
        }
    }
    Rect { x: min_x, y: min_y, w: max_x - min_x, h: max_y - min_y }
}

/// The finite extent of a set of midpoints, each span at least 1 and the
/// origin 0 when none is finite.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MidpointExtent {
    pub span_x: f64,
    pub span_y: f64,
    pub origin_x: f64,
    pub origin_y: f64,
}

#[must_use]
pub fn midpoint_extent(midpoints: &[Point]) -> MidpointExtent {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for m in midpoints {
        if !m.x.is_finite() || !m.y.is_finite() {
            continue;
        }
        min_x = js_min(min_x, m.x);
        min_y = js_min(min_y, m.y);
        max_x = js_max(max_x, m.x);
        max_y = js_max(max_y, m.y);
    }
    MidpointExtent {
        span_x: if min_x.is_finite() { js_max(max_x - min_x, 1.0) } else { 1.0 },
        span_y: if min_y.is_finite() { js_max(max_y - min_y, 1.0) } else { 1.0 },
        origin_x: if min_x.is_finite() { min_x } else { 0.0 },
        origin_y: if min_y.is_finite() { min_y } else { 0.0 },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Side, bounding_box_of, path_is_clear, path_length, segment_crosses_rect, side_point_at,
        union_rect, without_repeats,
    };
    use crate::geometry::{Point, Rect};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    const BOX: Rect = Rect { x: 0.0, y: 0.0, w: 10.0, h: 10.0 };

    #[test]
    fn a_segment_through_the_interior_crosses_and_one_lying_on_a_border_does_too() {
        // segmentCrossesRect's own answers, read off the TypeScript: a segment
        // collinear with a border passes the slab test (its parallel axis has
        // `near == 0`), so it counts, though the doc comment says otherwise;
        // one a pixel outside does not.
        assert!(segment_crosses_rect(p(-5.0, 5.0), p(15.0, 5.0), BOX));
        assert!(segment_crosses_rect(p(-5.0, 0.0), p(15.0, 0.0), BOX));
        assert!(!segment_crosses_rect(p(-5.0, -1.0), p(15.0, -1.0), BOX));
        assert!(!path_is_clear(&[p(-5.0, 0.0), p(15.0, 0.0), p(15.0, 20.0)], &[BOX]));
    }

    #[test]
    fn without_repeats_compares_each_point_with_the_input_before_it() {
        let path = [p(0.0, 0.0), p(0.0, 0.0), p(1.0, 0.0), p(f64::NAN, 0.0), p(f64::NAN, 0.0)];
        // NaN !== NaN, so both NaN points survive, as `filter` keeps them.
        assert_eq!(without_repeats(&path).len(), 4);
    }

    #[test]
    fn an_empty_union_is_none_and_an_empty_bounding_box_is_inverted() {
        assert_eq!(union_rect(&[]), None);
        let empty = bounding_box_of(&[]);
        assert!(empty.x.is_infinite() && empty.w == f64::NEG_INFINITY);
        assert_eq!(path_length(&[p(0.0, 0.0), p(3.0, 4.0), p(3.0, 10.0)]), 11.0);
        assert_eq!(side_point_at(BOX, Side::Right, 0.25), p(10.0, 2.5));
    }
}
