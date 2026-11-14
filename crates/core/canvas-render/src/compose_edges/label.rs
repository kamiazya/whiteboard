//! Where an edge's label sits (`edges/edge-label-anchor.ts`): the arc-length
//! midpoint of the DRAWN line, slid clear of what it would cover. The one
//! producer for the drawn label and the editor's inline label editor alike.

use core::cmp::Ordering;

use whiteboard_det::math::{compare_numbers, hypot};
use whiteboard_edge_routing::edge_rounding::flatten_rounded_edge_path;
use whiteboard_edge_routing::geometry::Point;
use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{BoundingBox, SceneNode, ScenePoint};

use crate::node_box::{LabelPlace, NodeBoxOptions, label_of, label_runs};
use whiteboard_model::node_content::is_frame;

/// The size of a label's box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LabelSize {
    pub w: f64,
    pub h: f64,
}

/// The arc-length midpoint and the drawn segment it lies on.
#[derive(Debug, Clone, Copy)]
struct Midpoint {
    point: ScenePoint,
    from: ScenePoint,
    to: ScenePoint,
}

const fn scene(p: Point) -> ScenePoint {
    ScenePoint { x: p.x, y: p.y }
}

/// The line as drawn: a rounded route's corners flattened as the backend draws them.
fn drawn_line(path: &[ScenePoint], rounded: bool) -> Vec<ScenePoint> {
    if !rounded {
        return path.to_vec();
    }
    let points: Vec<Point> = path.iter().map(|p| Point { x: p.x, y: p.y }).collect();
    flatten_rounded_edge_path(&points).into_iter().map(scene).collect()
}

/// None for a path that draws no line: fewer than two points, or every point at
/// one place (a route with a missing end), so no label floats at the origin.
fn midpoint_of(path: &[ScenePoint], rounded: bool) -> Option<Midpoint> {
    let first = path.first()?;
    if path.len() < 2 || path.iter().all(|p| p == first) {
        return None;
    }
    let drawn = drawn_line(path, rounded);
    let segments: Vec<(ScenePoint, ScenePoint, f64)> = drawn
        .windows(2)
        .filter_map(|pair| match pair {
            [from, to] => Some((*from, *to, hypot(to.x - from.x, to.y - from.y))),
            _ => None,
        })
        .collect();
    let total = segments.iter().fold(0.0, |sum, (_, _, length)| sum + length);
    let mut remaining = total / 2.0;
    for &(from, to, length) in &segments {
        if remaining <= length {
            let t = if length == 0.0 { 0.0 } else { remaining / length };
            let point =
                ScenePoint { x: from.x + t * (to.x - from.x), y: from.y + t * (to.y - from.y) };
            return Some(Midpoint { point, from, to });
        }
        remaining -= length;
    }
    let &(from, to, _) = segments.last()?;
    Some(Midpoint { point: to, from, to })
}

/// What an edge label must not lie over: every node but a frame, which is a
/// region rather than a box, the edge's own ends included, then `extra`.
#[must_use]
pub fn label_obstacles(nodes: &[SpatialNode], extra: &[BoundingBox]) -> Vec<BoundingBox> {
    nodes
        .iter()
        .filter(|node| !is_frame(node))
        .map(|node| BoundingBox { x: node.x, y: node.y, w: node.width, h: node.height })
        .chain(extra.iter().copied())
        .collect()
}

/// Where each frame's title is drawn: above the frame, outside the box a node
/// obstacle covers, yet text a label must not land on and a route must go round.
#[must_use]
pub fn frame_title_boxes(nodes: &[SpatialNode], options: &NodeBoxOptions<'_>) -> Vec<BoundingBox> {
    nodes
        .iter()
        .filter(|node| is_frame(node))
        .flat_map(|node| {
            label_runs(node, label_of(node, None).as_deref(), LabelPlace::Above, options)
        })
        .filter_map(|run| match run {
            SceneNode::TextRun(run) => Some(run.bbox),
            _ => None,
        })
        .collect()
}

/// How far apart the tried offsets are, and how many there are each way.
const LABEL_SLIDE_STEP_PX: f64 = 8.0;
const LABEL_SLIDE_STEPS: u8 = 16;

fn overlaps(a: &BoundingBox, b: &BoundingBox) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

const fn centred(at: ScenePoint, size: LabelSize) -> BoundingBox {
    BoundingBox { x: at.x - size.w / 2.0, y: at.y - size.h / 2.0, w: size.w, h: size.h }
}

/// Where a label of `size` sits on a route: its midpoint, unless a label centred
/// there would lie over one of `obstacles`; then the nearest clear spot, along
/// the line while it runs that far, else off it along the normal, above (or
/// left) before below (or right). Nothing clear within reach leaves it at the
/// midpoint. None for a path that draws no line.
#[must_use]
pub fn edge_label_placement(
    path: &[ScenePoint],
    size: LabelSize,
    obstacles: &[BoundingBox],
    rounded: bool,
) -> Option<ScenePoint> {
    let mid = midpoint_of(path, rounded)?;
    // Every candidate lies within the reach of the midpoint on both axes, so an
    // obstacle missing this box misses every candidate: one pass over the board.
    let margin = LABEL_SLIDE_STEP_PX * f64::from(LABEL_SLIDE_STEPS) + 1.0;
    let searched = BoundingBox {
        x: mid.point.x - margin - size.w / 2.0,
        y: mid.point.y - margin - size.h / 2.0,
        w: size.w + 2.0 * margin,
        h: size.h + 2.0 * margin,
    };
    let near: Vec<&BoundingBox> = obstacles.iter().filter(|o| overlaps(&searched, o)).collect();
    let clear = |at: &ScenePoint| !near.iter().any(|o| overlaps(&centred(*at, size), o));
    if clear(&mid.point) {
        return Some(mid.point);
    }
    Some(slide_candidates(&mid).into_iter().find(|at| clear(at)).unwrap_or(mid.point))
}

fn by_position(a: ScenePoint, b: ScenePoint) -> Ordering {
    compare_numbers(a.y, b.y).then(compare_numbers(a.x, b.x))
}

/// The two in ascending position, the first kept on a tie.
fn ascending<T: Copy>(pair: [T; 2], key: impl Fn(T) -> ScenePoint) -> [T; 2] {
    let [first, second] = pair;
    if by_position(key(second), key(first)) == Ordering::Less { [second, first] } else { pair }
}

/// The spots a blocked label tries, nearest first: at each distance, along the
/// drawn line both ways while it runs that far, then to either side of it.
fn slide_candidates(mid: &Midpoint) -> Vec<ScenePoint> {
    let length = hypot(mid.to.x - mid.from.x, mid.to.y - mid.from.y);
    if length == 0.0 {
        return Vec::new();
    }
    let dir =
        ScenePoint { x: (mid.to.x - mid.from.x) / length, y: (mid.to.y - mid.from.y) / length };
    let normals =
        ascending([ScenePoint { x: -dir.y, y: dir.x }, ScenePoint { x: dir.y, y: -dir.x }], |n| n);
    let ahead = hypot(mid.to.x - mid.point.x, mid.to.y - mid.point.y);
    let behind = hypot(mid.from.x - mid.point.x, mid.from.y - mid.point.y);
    let runs = ascending([(dir, ahead), (ScenePoint { x: -dir.x, y: -dir.y }, behind)], |r| r.0);
    let at =
        |n: ScenePoint, d: f64| ScenePoint { x: mid.point.x + n.x * d, y: mid.point.y + n.y * d };
    let mut found = Vec::new();
    for step in 1..=LABEL_SLIDE_STEPS {
        let d = LABEL_SLIDE_STEP_PX * f64::from(step);
        found.extend(runs.iter().filter(|(_, room)| d <= *room).map(|(n, _)| at(*n, d)));
        found.extend(normals.iter().map(|n| at(*n, d)));
    }
    found
}
