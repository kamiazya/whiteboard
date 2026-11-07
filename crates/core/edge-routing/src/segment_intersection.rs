//! The interior intersection the line jumps hop over: canvas-render's
//! `layout/edges/segment-intersection.ts`, ported as written. Plain
//! arithmetic in the TypeScript's own evaluation order, with [`hypot`] for
//! the length.

use crate::geometry::Point;
use whiteboard_det::math::hypot;

/// The hop arc's radius, as `EDGE_JUMP_RADIUS_PX`.
pub const EDGE_JUMP_RADIUS_PX: f64 = 5.0;

/// The straight run a hop needs on both sides, as `END_CLEARANCE_PX`.
pub const END_CLEARANCE_PX: f64 = EDGE_JUMP_RADIUS_PX + 1.0;

/// The proper interior intersection of `a1`-`a2` and `b1`-`b2`, or `None`
/// when they are parallel, meet outside either, overflow, or meet too close
/// to an end of the first to fit the arc.
#[must_use]
pub fn segment_intersection(a1: Point, a2: Point, b1: Point, b2: Point) -> Option<Point> {
    let dax = a2.x - a1.x;
    let day = a2.y - a1.y;
    let dbx = b2.x - b1.x;
    let dby = b2.y - b1.y;
    let denom = dax * dby - day * dbx;
    if denom == 0.0 {
        return None;
    }
    let t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom;
    let u = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / denom;
    if t <= 0.0 || t >= 1.0 || u <= 0.0 || u >= 1.0 {
        return None;
    }
    let point = Point { x: a1.x + t * dax, y: a1.y + t * day };
    if !point.x.is_finite() || !point.y.is_finite() {
        return None;
    }
    let len_a = hypot(dax, day);
    if t * len_a < END_CLEARANCE_PX || (1.0 - t) * len_a < END_CLEARANCE_PX {
        return None;
    }
    Some(point)
}

#[cfg(test)]
mod tests {
    use super::segment_intersection;
    use crate::geometry::Point;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn crossing_segments_meet_and_a_crossing_near_an_end_is_refused() {
        let hit = segment_intersection(p(0.0, 0.0), p(20.0, 0.0), p(10.0, -5.0), p(10.0, 5.0));
        assert_eq!(hit, Some(p(10.0, 0.0)));
        assert_eq!(
            segment_intersection(p(0.0, 0.0), p(20.0, 0.0), p(3.0, -5.0), p(3.0, 5.0)),
            None
        );
        assert_eq!(
            segment_intersection(p(0.0, 0.0), p(20.0, 0.0), p(0.0, 1.0), p(20.0, 1.0)),
            None
        );
    }
}
