//! The pairwise crossing and overlap scorer, ported from canvas-render's
//! `edge-crossing-sweep.ts`: a sweep-and-prune over x with a y-interval gate
//! as the broad phase, and the exact quantized segment-pair test as the
//! narrow one. Every quantity is a JavaScript number in the TypeScript, so
//! this keeps them `f64` and rounds with [`js_round`].
#![expect(clippy::float_cmp, reason = "the TypeScript compares with ===")]

use crate::geometry::Point;
use crate::js_map::JsMap;
use crate::routing_budget::RoutingBudget;
use crate::segment_intersection::EDGE_JUMP_RADIUS_PX;
use whiteboard_det::math::{compare_numbers, hypot, js_max, js_min, js_round};

/// Quarter-pixel integers, as `COST_QUANTUM`.
const COST_QUANTUM: f64 = 4.0;

/// The broad phase's bbox slack, in px, as `BROAD_PHASE_SLACK_PX`.
const BROAD_PHASE_SLACK_PX: f64 = 1.0 / COST_QUANTUM;

/// `EDGE_JUMP_RADIUS_PX + 1`, in quanta, as `CLEARANCE_Q`.
const CLEARANCE_Q: f64 = (EDGE_JUMP_RADIUS_PX + 1.0) * COST_QUANTUM;

/// One pair's `[overlap, illegible, crossings]`.
pub type PairScore = [f64; 3];

fn q(n: f64) -> f64 {
    js_round(n * COST_QUANTUM)
}

/// The narrow phase on raw coordinates, as `scoreSegmentPair`.
#[must_use]
pub fn score_segment_pair(a1: Point, a2: Point, b1: Point, b2: Point) -> PairScore {
    score_quantized_segment_pair(
        [q(a1.x), q(a1.y), q(a2.x), q(a2.y)],
        [q(b1.x), q(b1.y), q(b2.x), q(b2.y)],
    )
}

/// `|(dx, dy)|`, exact on an axis, as `axisLength`.
fn axis_length(dx: f64, dy: f64) -> f64 {
    if dx == 0.0 {
        return dy.abs();
    }
    if dy == 0.0 {
        return dx.abs();
    }
    js_round(hypot(dx, dy))
}

/// The collinear axis-aligned overlap of two spans, as the two branches
/// `scoreQuantizedSegmentPair` opens with.
fn overlap(a1: f64, a2: f64, b1: f64, b2: f64) -> PairScore {
    let lo = js_max(js_min(a1, a2), js_min(b1, b2));
    let hi = js_min(js_max(a1, a2), js_max(b1, b2));
    [if hi > lo { hi - lo } else { 0.0 }, 0.0, 0.0]
}

/// The narrow phase on already-quantized coordinates `[x1, y1, x2, y2]`, as
/// `scoreQuantizedSegmentPair`.
#[must_use]
pub fn score_quantized_segment_pair(a: [f64; 4], b: [f64; 4]) -> PairScore {
    let [ax1, ay1, ax2, ay2] = a;
    let [bx1, by1, bx2, by2] = b;
    if ay1 == ay2 && by1 == by2 && ay1 == by1 {
        return overlap(ax1, ax2, bx1, bx2);
    }
    if ax1 == ax2 && bx1 == bx2 && ax1 == bx1 {
        return overlap(ay1, ay2, by1, by2);
    }
    let (dax, day, dbx, dby) = (ax2 - ax1, ay2 - ay1, bx2 - bx1, by2 - by1);
    let mut denom = dax * dby - day * dbx;
    if denom == 0.0 {
        return [0.0; 3];
    }
    let mut tn = (bx1 - ax1) * dby - (by1 - ay1) * dbx;
    let mut un = (bx1 - ax1) * day - (by1 - ay1) * dax;
    if denom < 0.0 {
        denom = -denom;
        tn = -tn;
        un = -un;
    }
    // Written as the TypeScript's `<=`/`>=` chain so NaN takes its branch.
    if tn <= 0.0 || tn >= denom || un <= 0.0 || un >= denom {
        return [0.0; 3];
    }
    let (len_a, len_b) = (axis_length(dax, day), axis_length(dbx, dby));
    let near = |n: f64, len: f64| n * len < CLEARANCE_Q * denom;
    let illegible =
        near(tn, len_a) || near(denom - tn, len_a) || near(un, len_b) || near(denom - un, len_b);
    [0.0, if illegible { 1.0 } else { 0.0 }, 1.0]
}

/// Interior vertices two paths share, on the cost quantum, as
/// `sharedCorners`: each of `a`'s first counted once, compared with `===`.
#[must_use]
pub fn shared_corners(a: &[Point], b: &[Point]) -> f64 {
    let interior = |p: &[Point]| p.get(1..p.len().saturating_sub(1)).unwrap_or(&[]).to_vec();
    let (a_in, b_in) = (interior(a), interior(b));
    let mut count = 0.0;
    for (i, p) in a_in.iter().enumerate() {
        let (x, y) = (q(p.x), q(p.y));
        let repeated = a_in.iter().take(i).any(|k| q(k.x) == x && q(k.y) == y);
        if repeated {
            continue;
        }
        if b_in.iter().any(|v| q(v.x) == x && q(v.y) == y) {
            count += 1.0;
        }
    }
    count
}

/// A quantized vertex as the TypeScript's `` `${qx},${qy}` `` string key:
/// `-0` prints as `0`, and every NaN prints alike.
fn vertex_key(p: Point) -> (u64, u64) {
    let canonical = |v: f64| {
        if v.is_nan() {
            f64::NAN.to_bits()
        } else if v == 0.0 {
            0.0_f64.to_bits()
        } else {
            v.to_bits()
        }
    };
    (canonical(q(p.x)), canonical(q(p.y)))
}

/// A pair's key, `i * paths.length + j`.
type PairKey = usize;

/// Adds one pair's triple; an all-zero triple is not recorded, as `addPairScore`.
fn add_pair_score(scores: &mut JsMap<PairKey, PairScore>, key: PairKey, triple: PairScore) {
    if triple == [0.0; 3] {
        return;
    }
    if let Some(entry) = scores.get_mut(&key) {
        for (sum, v) in entry.iter_mut().zip(triple) {
            *sum += v;
        }
    } else {
        scores.set(key, triple);
    }
}

/// Each pair of edges sharing an interior vertex, once per shared vertex,
/// as `addSharedCorners`.
fn add_shared_corners(paths: &[Vec<Point>], scores: &mut JsMap<PairKey, PairScore>) {
    let mut by_vertex: JsMap<(u64, u64), Vec<usize>> = JsMap::default();
    for (edge, path) in paths.iter().enumerate() {
        let mut seen: Vec<(u64, u64)> = Vec::new();
        for &p in path.get(1..path.len().saturating_sub(1)).unwrap_or(&[]) {
            let key = vertex_key(p);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            if let Some(at) = by_vertex.get_mut(&key) {
                at.push(edge);
            } else {
                by_vertex.set(key, vec![edge]);
            }
        }
    }
    let n = paths.len();
    for edges in by_vertex.values() {
        for (i, &e1) in edges.iter().enumerate() {
            for &e2 in edges.iter().skip(i).skip(1) {
                add_pair_score(scores, e1.saturating_mul(n).saturating_add(e2), [0.0, 0.0, 1.0]);
            }
        }
    }
}

/// One path segment as the sweep holds it, as `SweepSegment`.
#[derive(Debug, Clone, Copy)]
struct SweepSegment {
    edge: usize,
    a: Point,
    b: Point,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

/// Every segment, inflated by the slack, in the order the sweep consumes
/// them, as `sweepSegments`.
fn sweep_segments(paths: &[Vec<Point>]) -> Vec<SweepSegment> {
    let mut segments: Vec<SweepSegment> = paths
        .iter()
        .enumerate()
        .flat_map(|(edge, path)| {
            path.windows(2).filter_map(move |w| match *w {
                [a, b] => Some(SweepSegment {
                    edge,
                    a,
                    b,
                    min_x: js_min(a.x, b.x) - BROAD_PHASE_SLACK_PX,
                    max_x: js_max(a.x, b.x) + BROAD_PHASE_SLACK_PX,
                    min_y: js_min(a.y, b.y) - BROAD_PHASE_SLACK_PX,
                    max_y: js_max(a.y, b.y) + BROAD_PHASE_SLACK_PX,
                }),
                _ => None,
            })
        })
        .collect();
    // A consistent comparator, so the stable sort answers as V8's does.
    segments.sort_by(|s1, s2| {
        compare_numbers(s1.min_x, s2.min_x)
            .then(compare_numbers(s1.max_x, s2.max_x))
            .then(s1.edge.cmp(&s2.edge))
    });
    segments
}

/// `segment` against every active segment of another edge whose y-span
/// meets it, as `scoreAgainstActive`.
fn score_against_active(
    segment: &SweepSegment,
    active: &[SweepSegment],
    edge_count: usize,
    scores: &mut JsMap<PairKey, PairScore>,
) {
    for other in active {
        if other.edge == segment.edge {
            continue;
        }
        if other.max_y < segment.min_y || other.min_y > segment.max_y {
            continue;
        }
        let (lo, hi) = if other.edge < segment.edge { (other, segment) } else { (segment, other) };
        let key = lo.edge.saturating_mul(edge_count).saturating_add(hi.edge);
        add_pair_score(scores, key, score_segment_pair(lo.a, lo.b, hi.a, hi.b));
    }
}

/// Every edge pair's summed `[overlap, illegible, crossings]`, keyed by
/// `i * paths.len() + j` with `i < j`, as `buildPairwiseScores`. `None` when
/// the sweep would examine more segment pairs than `budget.pairs` has left;
/// what it examined is spent either way.
#[must_use]
pub fn build_pairwise_scores(
    paths: &[Vec<Point>],
    budget: Option<&mut RoutingBudget>,
) -> Option<JsMap<PairKey, PairScore>> {
    let allowance = budget.as_ref().map_or(f64::INFINITY, |b| b.pairs);
    let mut scores = JsMap::default();
    let mut active: Vec<SweepSegment> = Vec::new();
    let mut examined = 0.0;
    for segment in sweep_segments(paths) {
        active.retain(|s| s.max_x >= segment.min_x);
        #[expect(clippy::cast_precision_loss, reason = "an active count is far below 2^53")]
        let held = active.len() as f64;
        examined += held;
        if examined > allowance {
            break;
        }
        score_against_active(&segment, &active, paths.len(), &mut scores);
        active.push(segment);
    }
    if let Some(b) = budget {
        b.pairs -= examined;
    }
    if examined > allowance {
        return None;
    }
    add_shared_corners(paths, &mut scores);
    Some(scores)
}

#[cfg(test)]
mod tests {
    use super::score_quantized_segment_pair;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    /// A diagonal's length is rounded before the clearance test: here the
    /// crossing sits at t = 0.5 on a diagonal of hypot(30, 37) = 47.63,
    /// rounded to 48, which puts it exactly on the 24-quantum clearance, not
    /// inside it. The TypeScript answers `[0, 0, 1]` (measured); without the
    /// rounding it would read illegible. No generated draw lands on that
    /// boundary.
    #[test]
    fn a_diagonal_length_is_rounded_before_the_clearance_test() {
        let a = [0.0, 0.0, 30.0, 37.0];
        let b = [15.0, -100.0, 15.0, 200.0];
        assert_eq!(score_quantized_segment_pair(a, b), [0.0, 0.0, 1.0]);
    }
}
