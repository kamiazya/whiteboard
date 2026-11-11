//! The drawn edge line as a dense polyline, rounded corners AND line-jump hops
//! included, for consumers that need points rather than an SVG path (the
//! editor's hit-testing and selection highlight, and sketch ink). It mirrors
//! the SVG backend's emission branch for branch: plain segments hop every jump
//! on their segment; rounded paths truncate spans to the corner midpoints and
//! drop hops without arc clearance, exactly like the backend's path data.

use core::f64::consts::PI;
use whiteboard_det::math::{cos, hypot, sin};
use whiteboard_edge_routing::edge_rounding::{flatten_rounded_edge_path, rounded_edge_corners};
use whiteboard_edge_routing::geometry::Point;
use whiteboard_edge_routing::segment_intersection::EDGE_JUMP_RADIUS_PX;
use whiteboard_scene::{EdgeJumpPoint, ScenePoint};

/// Chord count per hop; matches the corner flattening's sub-pixel budget.
const HOP_SUBDIVISIONS: u8 = 8;

/// The edge router's point, as the scene's.
#[must_use]
pub fn scene_point(point: Point) -> ScenePoint {
    ScenePoint { x: point.x, y: point.y }
}

fn routed_point(point: ScenePoint) -> Point {
    Point { x: point.x, y: point.y }
}

/// Where a hop's half-circle meets the base line: entry and exit one jump
/// radius before and after the crossing, along the direction of travel. The ONE
/// producer of hop endpoints, so the backend's `A` command and this module's
/// sampling both start and land here.
#[must_use]
pub fn hop_endpoints(
    from: ScenePoint,
    to: ScenePoint,
    jump: ScenePoint,
) -> Option<(ScenePoint, ScenePoint)> {
    let len = hypot(to.x - from.x, to.y - from.y);
    if len == 0.0 {
        return None;
    }
    let ux = (to.x - from.x) / len;
    let uy = (to.y - from.y) / len;
    let r = EDGE_JUMP_RADIUS_PX;
    Some((
        ScenePoint { x: jump.x - ux * r, y: jump.y - uy * r },
        ScenePoint { x: jump.x + ux * r, y: jump.y + uy * r },
    ))
}

/// A sampled half-circle over `jump` on the run `from` to `to`, bulging to the
/// LEFT of travel (the same sweep the backend's `A` command draws), including
/// the entry and exit points on the base line.
fn hop_points(from: ScenePoint, to: ScenePoint, jump: ScenePoint) -> Vec<ScenePoint> {
    let len = hypot(to.x - from.x, to.y - from.y);
    if len == 0.0 {
        return Vec::new();
    }
    let ux = (to.x - from.x) / len;
    let uy = (to.y - from.y) / len;
    // Left of travel in SVG's y-down coordinates.
    let (nx, ny) = (uy, -ux);
    let r = EDGE_JUMP_RADIUS_PX;
    (0..=HOP_SUBDIVISIONS)
        .map(|step| {
            let t = f64::from(step) / f64::from(HOP_SUBDIVISIONS);
            ScenePoint {
                x: jump.x - ux * r * cos(PI * t) + nx * r * sin(PI * t),
                y: jump.y - uy * r * cos(PI * t) + ny * r * sin(PI * t),
            }
        })
        .collect()
}

/// The points after `from` along the run to `to`, hopping each jump.
fn span_points(from: ScenePoint, to: ScenePoint, jumps: &[ScenePoint]) -> Vec<ScenePoint> {
    let mut points: Vec<ScenePoint> =
        jumps.iter().flat_map(|jump| hop_points(from, to, *jump)).collect();
    points.push(to);
    points
}

fn as_point(jump: &EdgeJumpPoint) -> ScenePoint {
    ScenePoint { x: jump.x, y: jump.y }
}

/// Whether a jump records the path segment at `index`.
#[must_use]
pub fn jump_is_on(jump: &EdgeJumpPoint, index: usize) -> bool {
    u32::try_from(index).is_ok_and(|i| (jump.segment - f64::from(i)).abs() == 0.0)
}

/// The jumps on original segment `segment` that fall INSIDE the drawn span
/// `from` to `to` with enough clearance for the arc. A rounded corner truncates
/// its segments to midpoints, so a hop computed near a corner may fall in the
/// curve zone; those are dropped rather than deforming the corner. Shared with
/// the SVG backend so "which hops are drawn" has one producer.
#[must_use]
pub fn jumps_within_span(
    jumps: &[EdgeJumpPoint],
    segment: usize,
    from: ScenePoint,
    to: ScenePoint,
) -> Vec<EdgeJumpPoint> {
    let len = hypot(to.x - from.x, to.y - from.y);
    if len == 0.0 {
        return Vec::new();
    }
    let ux = (to.x - from.x) / len;
    let uy = (to.y - from.y) / len;
    jumps
        .iter()
        .filter(|jump| {
            if !jump_is_on(jump, segment) {
                return false;
            }
            let t = (jump.x - from.x) * ux + (jump.y - from.y) * uy;
            t > EDGE_JUMP_RADIUS_PX && t < len - EDGE_JUMP_RADIUS_PX
        })
        .copied()
        .collect()
}

/// The drawn edge as a polyline. `rounded` and `jumps` compose exactly as the
/// backend composes them; with neither, the input path returns as it is.
#[must_use]
pub fn flatten_drawn_edge_path(
    path: &[ScenePoint],
    jumps: &[EdgeJumpPoint],
    rounded: bool,
) -> Vec<ScenePoint> {
    if jumps.is_empty() {
        return if rounded { flatten_rounded(path) } else { path.to_vec() };
    }
    let (Some(&first), Some(&last)) = (path.first(), path.last()) else { return path.to_vec() };
    if !rounded || path.len() < 3 {
        return flatten_plain(path, jumps, first, last, rounded);
    }
    flatten_rounded_with_jumps(path, jumps, first, last)
}

fn flatten_rounded(path: &[ScenePoint]) -> Vec<ScenePoint> {
    let routed: Vec<Point> = path.iter().copied().map(routed_point).collect();
    flatten_rounded_edge_path(&routed).into_iter().map(scene_point).collect()
}

/// Straight runs (or a rounded path too short to have a corner), hopping each
/// jump on its segment.
fn flatten_plain(
    path: &[ScenePoint],
    jumps: &[EdgeJumpPoint],
    first: ScenePoint,
    last: ScenePoint,
    rounded: bool,
) -> Vec<ScenePoint> {
    let mut points = vec![first];
    let whole_span = rounded.then(|| jumps_within_span(jumps, 0, first, last));
    for (seg, pair) in path.windows(2).enumerate() {
        let [from, to] = pair else { continue };
        let on_segment: Vec<EdgeJumpPoint> = match &whole_span {
            Some(span) => span.clone(),
            None => jumps.iter().filter(|j| jump_is_on(j, seg)).copied().collect(),
        };
        let spots: Vec<ScenePoint> = on_segment.iter().map(as_point).collect();
        points.extend(span_points(*from, *to, &spots));
    }
    points
}

fn flatten_rounded_with_jumps(
    path: &[ScenePoint],
    jumps: &[EdgeJumpPoint],
    first: ScenePoint,
    last: ScenePoint,
) -> Vec<ScenePoint> {
    let mut points = vec![first];
    let mut current = first;
    let routed: Vec<Point> = path.iter().copied().map(routed_point).collect();
    let corners = rounded_edge_corners(&routed);
    for (index, corner) in corners.iter().enumerate() {
        let (enter, control, leave) =
            (scene_point(corner.enter), scene_point(corner.control), scene_point(corner.leave));
        let spots: Vec<ScenePoint> =
            jumps_within_span(jumps, index, current, enter).iter().map(as_point).collect();
        points.extend(span_points(current, enter, &spots));
        for step in 1..=HOP_SUBDIVISIONS {
            let t = f64::from(step) / f64::from(HOP_SUBDIVISIONS);
            let u = 1.0 - t;
            points.push(ScenePoint {
                x: u * u * enter.x + 2.0 * u * t * control.x + t * t * leave.x,
                y: u * u * enter.y + 2.0 * u * t * control.y + t * t * leave.y,
            });
        }
        current = leave;
    }
    let spots: Vec<ScenePoint> =
        jumps_within_span(jumps, corners.len(), current, last).iter().map(as_point).collect();
    points.extend(span_points(current, last, &spots));
    points
}
