//! Moving an anchor along its own side: canvas-render's
//! `layout/edges/side-slides.ts`, ported function for function. The
//! reasoning is written once, in the TypeScript; `Math.min`/`Math.max` are
//! [`js_min`]/[`js_max`] here, and every comparison is the TypeScript's own.

use crate::edge_geometry::{Side, outward_normal, path_is_clear, tangent_coordinate};
use crate::edge_rules::{SLIDE_CORNER_INSET_PX, opposite_side};
use crate::geometry::{Point, Rect};
use whiteboard_det::math::{js_max, js_min};

const fn is_vertical(side: Side) -> bool {
    matches!(side, Side::Left | Side::Right)
}

/// A side's span inset from its corners.
fn inset_span(rect: Rect, side: Side) -> (f64, f64) {
    if is_vertical(side) {
        (
            rect.y + js_min(SLIDE_CORNER_INSET_PX, rect.h / 2.0),
            rect.y + rect.h - js_min(SLIDE_CORNER_INSET_PX, rect.h / 2.0),
        )
    } else {
        (
            rect.x + js_min(SLIDE_CORNER_INSET_PX, rect.w / 2.0),
            rect.x + rect.w - js_min(SLIDE_CORNER_INSET_PX, rect.w / 2.0),
        )
    }
}

/// `anchor` slid along `side` to `target`'s tangent coordinate, or `None`
/// when that lies outside the side's inset span.
#[must_use]
pub fn slide_along_side(anchor: Point, rect: Rect, side: Side, target: Point) -> Option<Point> {
    let (lo, hi) = inset_span(rect, side);
    if is_vertical(side) {
        (target.y >= lo && target.y <= hi).then_some(Point { x: anchor.x, y: target.y })
    } else {
        (target.x >= lo && target.x <= hi).then_some(Point { x: target.x, y: anchor.y })
    }
}

/// What two facing sides are routed between.
pub struct FacingEnds {
    pub start: Point,
    pub end: Point,
    pub from_side: Side,
    pub to_side: Side,
    pub from_rect: Rect,
    pub to_rect: Rect,
}

/// The straight run between two facing sides, both anchors slid onto one
/// tangent coordinate in their shared lane, or `None` when there is none or
/// it is blocked.
#[must_use]
pub fn try_zero_bend_slide(ends: &FacingEnds, inflated: &[Rect]) -> Option<Vec<Point>> {
    let FacingEnds { start, end, from_side, to_side, from_rect, to_rect } = *ends;
    if from_side != opposite_side(to_side) {
        return None;
    }
    let from_normal = outward_normal(from_side);
    let facing = from_normal.x * (end.x - start.x) + from_normal.y * (end.y - start.y) > 0.0;
    if !facing {
        return None;
    }
    let with_tangent = |anchor: Point, side: Side, t: f64| {
        if is_vertical(side) { Point { x: anchor.x, y: t } } else { Point { x: t, y: anchor.y } }
    };
    let (from_lo, from_hi) = inset_span(from_rect, from_side);
    let (to_lo, to_hi) = inset_span(to_rect, to_side);
    let lo = js_max(from_lo, to_lo);
    let hi = js_min(from_hi, to_hi);
    if lo > hi {
        return None;
    }
    let start_t = tangent_coordinate(from_side, start);
    let end_t = tangent_coordinate(to_side, end);
    let t = if start_t >= lo && start_t <= hi {
        start_t
    } else if end_t >= lo && end_t <= hi {
        end_t
    } else {
        js_min(hi, js_max(lo, start_t))
    };
    let aligned = vec![with_tangent(start, from_side, t), with_tangent(end, to_side, t)];
    path_is_clear(&aligned, inflated).then_some(aligned)
}

const MIN_APPROACH_PX: f64 = 20.0;

/// The departure anchor slid so a perpendicular arrival gets its minimum
/// approach, where its own side allows.
#[must_use]
pub fn slid_for_approach(ends: &FacingEnds, to_normal: Point) -> Point {
    let FacingEnds { start, end, from_side, to_side, from_rect, .. } = *ends;
    if from_side == to_side || from_side == opposite_side(to_side) {
        return start;
    }
    let approach = to_normal.x * (start.x - end.x) + to_normal.y * (start.y - end.y);
    if approach <= 0.0 || approach >= MIN_APPROACH_PX {
        return start;
    }
    let shortfall = MIN_APPROACH_PX - approach;
    slide_along_side(
        start,
        from_rect,
        from_side,
        Point { x: start.x + to_normal.x * shortfall, y: start.y + to_normal.y * shortfall },
    )
    .unwrap_or(start)
}

/// A same-side U's stub depth, deepened so the arrival gets its minimum
/// approach.
#[must_use]
pub fn deepened_corridor(
    start: Point,
    end: Point,
    sides: (Side, Side),
    from_depth: f64,
    to_normal: Point,
) -> f64 {
    let (from_side, to_side) = sides;
    if from_side != to_side {
        return from_depth;
    }
    let arrival_overshoot = to_normal.x * (end.x - start.x) + to_normal.y * (end.y - start.y);
    let approach = from_depth - arrival_overshoot;
    if approach <= 0.0 || approach >= MIN_APPROACH_PX {
        return from_depth;
    }
    arrival_overshoot + MIN_APPROACH_PX
}

#[cfg(test)]
mod tests {
    use super::{FacingEnds, slide_along_side, try_zero_bend_slide};
    use crate::edge_geometry::Side;
    use crate::geometry::{Point, Rect};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn facing_sides_share_a_straight_run_on_the_departure_coordinate() {
        let ends = FacingEnds {
            start: p(100.0, 20.0),
            end: p(200.0, 40.0),
            from_side: Side::Right,
            to_side: Side::Left,
            from_rect: Rect { x: 0.0, y: 0.0, w: 100.0, h: 60.0 },
            to_rect: Rect { x: 200.0, y: 0.0, w: 100.0, h: 60.0 },
        };
        assert_eq!(try_zero_bend_slide(&ends, &[]), Some(vec![p(100.0, 20.0), p(200.0, 20.0)]));
        let wall = Rect { x: 140.0, y: 0.0, w: 10.0, h: 60.0 };
        assert_eq!(try_zero_bend_slide(&ends, &[wall]), None);
        assert_eq!(
            slide_along_side(p(100.0, 20.0), ends.from_rect, Side::Right, p(0.0, 55.0)),
            None
        );
    }
}
