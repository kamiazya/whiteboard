//! A node's silhouette, resolved from the shape table.
//!
//! The ONE producer of non-rect node silhouettes, so the backend draws the
//! outline the plugin decomposes and hit-testing and edge anchoring answer
//! against the same decomposition. The table is the bundled visual plugin's
//! (`whiteboard_plugin_visual::render`), always; a caller-supplied table is not
//! ported.

use core::cmp::Ordering;

use crate::finite_box::is_finite_box;
use whiteboard_det::math::{hypot, js_max, js_min};
use whiteboard_plugin_visual::render::{shape_content_box, shape_outline};
use whiteboard_scene::{BoundingBox, NodeOutline, ScenePoint};

/// The outline of silhouette `shape_id` in `bbox`. An unknown id degrades to
/// none, a plain rect, like any other malformed input: the value arrives from a
/// stored facet payload, and a document naming a shape this build does not
/// carry is ordinary. A box with a non-finite field has no outline either.
#[must_use]
pub fn node_outline(shape_id: &str, bbox: &BoundingBox) -> Option<NodeOutline> {
    if !is_finite_box(bbox) {
        return None;
    }
    shape_outline(shape_id, bbox)
}

/// The axis-aligned box inside silhouette `shape_id` where a node's content can
/// lay out without crossing it. No silhouette, an unknown one, or a box with a
/// non-finite field is its own content box, per [`node_outline`]'s none.
#[must_use]
pub fn outline_content_box(shape_id: Option<&str>, bbox: &BoundingBox) -> BoundingBox {
    shape_id
        .filter(|_| is_finite_box(bbox))
        .and_then(|id| shape_content_box(id, bbox))
        .unwrap_or(*bbox)
}

/// Whether `point` lies inside or on silhouette `shape_id` in `bbox`: the
/// hit-test half of the one producer. A non-finite point, a box with no outline
/// and an unknown silhouette answer false.
#[must_use]
pub fn outline_contains(shape_id: &str, bbox: &BoundingBox, point: ScenePoint) -> bool {
    if !point.x.is_finite() || !point.y.is_finite() {
        return false;
    }
    node_outline(shape_id, bbox).is_some_and(|outline| outline_holds(&outline, point))
}

fn outline_holds(outline: &NodeOutline, point: ScenePoint) -> bool {
    match outline {
        NodeOutline::Ellipse { cx, cy, rx, ry } => inside_ellipse(point, *cx, *cy, *rx, *ry),
        NodeOutline::Polygon { points } => convex_polygon_contains(points, point),
        NodeOutline::Cylinder { x, y, w, h, ry } => {
            if point.x < *x || point.x > x + w {
                return false;
            }
            if point.y >= y + ry && point.y <= y + h - ry {
                return true;
            }
            let rx = w / 2.0;
            if rx <= 0.0 || *ry <= 0.0 {
                return point.y >= *y && point.y <= y + h;
            }
            // Above the body, the upper half of the lid; below it, the lower half of the bulge.
            let cap_cy = if point.y < y + ry { y + ry } else { y + h - ry };
            inside_ellipse(point, x + rx, cap_cy, rx, *ry)
        }
    }
}

/// Inside or on an axis-aligned ellipse; a degenerate one holds only its centre.
fn inside_ellipse(point: ScenePoint, cx: f64, cy: f64, rx: f64, ry: f64) -> bool {
    if rx <= 0.0 || ry <= 0.0 {
        return point == ScenePoint { x: cx, y: cy };
    }
    let nx = (point.x - cx) / rx;
    let ny = (point.y - cy) / ry;
    nx * nx + ny * ny <= 1.0
}

/// Inside a convex polygon of either winding: on the same side of every edge,
/// a point on an edge fixing no side. The vertex box is checked first, since a
/// polygon collapsed to a point or a segment zeroes every cross product and the
/// walk alone would hold the whole plane or the whole line.
fn convex_polygon_contains(points: &[ScenePoint], point: ScenePoint) -> bool {
    let Some(first) = points.first() else { return false };
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (first.x, first.x, first.y, first.y);
    for p in points {
        (min_x, max_x) = (js_min(min_x, p.x), js_max(max_x, p.x));
        (min_y, max_y) = (js_min(min_y, p.y), js_max(max_y, p.y));
    }
    if point.x < min_x || point.x > max_x || point.y < min_y || point.y > max_y {
        return false;
    }
    let mut sign = Ordering::Equal;
    for (a, b) in points.iter().zip(points.iter().cycle().skip(1)) {
        let cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
        if cross == 0.0 {
            continue;
        }
        // A cross that is not a number (vertices past `f64::MAX`) counts as negative.
        let current = if cross > 0.0 { Ordering::Greater } else { Ordering::Less };
        if sign == Ordering::Equal {
            sign = current;
        } else if sign != current {
            return false;
        }
    }
    true
}

/// Bisection steps for the boundary crossing: 2^-32 of the probed span is far
/// below a hundredth of a pixel at canvas scale.
const ENTRY_SEARCH_ITERATIONS: u32 = 32;

/// Where the extension of `from` to `to` first meets silhouette `shape_id` at
/// or beyond `to`: a route ends on the box's border, outside every inscribed
/// silhouette but at its tangents, so its terminal is pulled inward along the
/// approach. Found by bisecting [`outline_contains`], so the anchor lands on
/// the very boundary hit-testing answers for. `to` itself whenever the probe
/// never enters the outline or an input is not finite.
#[must_use]
pub fn outline_entry_point(
    shape_id: &str,
    bbox: &BoundingBox,
    from: ScenePoint,
    to: ScenePoint,
) -> ScenePoint {
    if !is_finite_box(bbox) || ![from.x, from.y, to.x, to.y].iter().all(|v| v.is_finite()) {
        return to;
    }
    if outline_contains(shape_id, bbox, to) {
        return to;
    }
    let center = ScenePoint { x: bbox.x + bbox.w / 2.0, y: bbox.y + bbox.h / 2.0 };
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let length = hypot(dx, dy);
    // With no approach to follow, the probe heads for the centre.
    let (dir_x, dir_y) =
        if length > 0.0 { (dx / length, dy / length) } else { (center.x - to.x, center.y - to.y) };
    // As far as the ray's closest approach to the centre, past which it leaves
    // again: the projection, since walking the whole distance on an off-centre
    // approach overshoots the far rim. A span that is not finite (a zero
    // direction divides zero by zero, a huge one overflows) puts `far` at no
    // finite point, which no outline contains, so it needs no guard of its own.
    let dir_length = hypot(dir_x, dir_y);
    let span = js_max(0.0, ((center.x - to.x) * dir_x + (center.y - to.y) * dir_y) / dir_length);
    let far =
        ScenePoint { x: to.x + dir_x / dir_length * span, y: to.y + dir_y / dir_length * span };
    if !outline_contains(shape_id, bbox, far) {
        return to;
    }
    let along = |t: f64| ScenePoint { x: to.x + (far.x - to.x) * t, y: to.y + (far.y - to.y) * t };
    let (mut outside, mut inside) = (0.0, 1.0);
    for _ in 0..ENTRY_SEARCH_ITERATIONS {
        let mid = f64::midpoint(outside, inside);
        if outline_contains(shape_id, bbox, along(mid)) {
            inside = mid;
        } else {
            outside = mid;
        }
    }
    along(inside)
}
