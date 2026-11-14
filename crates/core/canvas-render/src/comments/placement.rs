//! Where a comment's bubble sits relative to its anchor
//! (`layout/comment-placement.ts`). A bubble floats beside the anchor and must
//! not cover what the comment is about: candidates are scored by how much of
//! each lies over an obstacle, and the least-covered wins, the earliest on a
//! tie. The four diagonal quadrants come first, so a board with room answers
//! as it did before the ring existed; past them a ring of sixteen directions at
//! four distances. A boxed-in anchor still gets the least bad candidate.

use whiteboard_det::math::{cos, js_max, js_min, sin};
use whiteboard_scene::{BoundingBox, ScenePoint};

/// Gap from the anchor to the bubble's nearest corner.
pub const COMMENT_BUBBLE_OFFSET_PX: f64 = 14.0;

/// How far out the ring reaches; it is the last distance tried, not a filter.
pub const COMMENT_BUBBLE_RING_REACH_PX: f64 = 180.0;

const RING_DIRECTIONS: u32 = 16;
const RING_DISTANCES_PX: [f64; 4] = [40.0, 80.0, 120.0, COMMENT_BUBBLE_RING_REACH_PX];

/// The four quadrants down-right, up-right, down-left, up-left, each hung by a
/// corner a whole offset off the anchor.
fn quadrants(anchor: ScenePoint, w: f64, h: f64) -> [BoundingBox; 4] {
    let d = COMMENT_BUBBLE_OFFSET_PX;
    let right = anchor.x + d;
    let left = anchor.x - d - w;
    let below = anchor.y + d;
    let above = anchor.y - d - h;
    let at = |x: f64, y: f64| BoundingBox { x, y, w, h };
    [at(right, below), at(right, above), at(left, below), at(left, above)]
}

/// The candidate boxes in preference order (`commentBubbleCandidates`): the
/// quadrants, then the ring, each ring box centred on its ray (a direction has
/// no corner to choose), nearest distance first.
#[must_use]
pub fn comment_bubble_candidates(anchor: ScenePoint, w: f64, h: f64) -> Vec<BoundingBox> {
    let mut out = quadrants(anchor, w, h).to_vec();
    for distance in RING_DISTANCES_PX {
        for k in 0..RING_DIRECTIONS {
            let angle = f64::from(k) / f64::from(RING_DIRECTIONS) * 2.0 * core::f64::consts::PI;
            let center_x = anchor.x + cos(angle) * (distance + w / 2.0);
            let center_y = anchor.y + sin(angle) * (distance + h / 2.0);
            out.push(BoundingBox { x: center_x - w / 2.0, y: center_y - h / 2.0, w, h });
        }
    }
    out
}

/// How much of `candidate` the obstacles cover, summed; an overlap with no
/// area adds nothing.
fn covered_area(candidate: &BoundingBox, obstacles: &[BoundingBox]) -> f64 {
    obstacles.iter().fold(0.0, |sum, obstacle| {
        let w = js_min(candidate.x + candidate.w, obstacle.x + obstacle.w)
            - js_max(candidate.x, obstacle.x);
        let h = js_min(candidate.y + candidate.h, obstacle.y + obstacle.h)
            - js_max(candidate.y, obstacle.y);
        if w > 0.0 && h > 0.0 { sum + w * h } else { sum }
    })
}

/// The least-covered candidate (`placeCommentBubble`). Strictly less, so an
/// earlier candidate keeps a tie, a tie at zero included; one whose cover is
/// NaN is never taken, so a board whose every cover is NaN keeps the first.
#[must_use]
pub fn place_comment_bubble(
    anchor: ScenePoint,
    w: f64,
    h: f64,
    obstacles: &[BoundingBox],
) -> BoundingBox {
    let [mut best, ..] = quadrants(anchor, w, h);
    let mut best_covered = f64::INFINITY;
    for candidate in comment_bubble_candidates(anchor, w, h) {
        let covered = covered_area(&candidate, obstacles);
        if covered < best_covered {
            best = candidate;
            best_covered = covered;
        }
    }
    best
}

/// The point on the bubble's rounded corner nearest the anchor
/// (`commentLeaderEnd`), inset diagonally onto the arc so the leader meets the
/// border rather than the box's corner outside the fill.
#[must_use]
pub fn comment_leader_end(anchor: ScenePoint, bubble: &BoundingBox, radius: f64) -> ScenePoint {
    let inset = radius * (1.0 - core::f64::consts::FRAC_1_SQRT_2);
    let center_x = bubble.x + bubble.w / 2.0;
    let center_y = bubble.y + bubble.h / 2.0;
    ScenePoint {
        x: if anchor.x <= center_x { bubble.x + inset } else { bubble.x + bubble.w - inset },
        y: if anchor.y <= center_y { bubble.y + inset } else { bubble.y + bubble.h - inset },
    }
}

/// The point of a polyline nearest `point` (`nearestPointOnPolyline`), where a
/// comment about an edge is pinned so it rides a reroute. Each point is tried
/// as a segment to the next, the last as a segment of no length; an empty path
/// answers the point itself.
#[must_use]
pub fn nearest_point_on_polyline(point: ScenePoint, path: &[ScenePoint]) -> ScenePoint {
    let mut best = point;
    let mut best_distance = f64::INFINITY;
    let ends = path.iter().skip(1).chain(path.last());
    for (a, b) in path.iter().zip(ends) {
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let length_squared = dx * dx + dy * dy;
        let t = if length_squared == 0.0 {
            0.0
        } else {
            js_max(0.0, js_min(1.0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length_squared))
        };
        let candidate = ScenePoint { x: a.x + t * dx, y: a.y + t * dy };
        let (ex, ey) = (candidate.x - point.x, candidate.y - point.y);
        let distance = ex * ex + ey * ey;
        if distance < best_distance {
            best = candidate;
            best_distance = distance;
        }
    }
    best
}
