//! Where a run's crossings land and which of them draw an arc: `segmentCarrying`,
//! `spacedHops`, `placeCrossings` and `handOverHop` in canvas-render's
//! `layout/edges/edge-jumps.ts`.

use std::collections::BTreeMap;

use whiteboard_det::math::{compare_numbers, hypot};

use super::{JumpPoint, MAX_HOPS_PER_SEGMENT, Run};
use crate::geometry::Point;
use crate::js_map::JsMap;
use crate::segment_intersection::{EDGE_JUMP_RADIUS_PX, END_CLEARANCE_PX, segment_intersection};

/// A crossing on a path segment: where, and how far along it, 0 at its start
/// and 1 at its end.
#[derive(Debug, Clone, Copy)]
pub(super) struct Crossing {
    point: Point,
    t: f64,
}

/// A crossing on the path segment that carries it, with that segment's length.
#[derive(Debug, Clone, Copy)]
pub(super) struct Carried {
    crossing: Crossing,
    segment: usize,
    length: f64,
}

/// The crossings found on one run, grouped by the path segment that carries
/// them, each group with that segment's length.
pub(super) type OnSegment = BTreeMap<usize, (Vec<Crossing>, f64)>;

/// The path segment of `run` that can carry a hop at `point`: the one the
/// point falls on with a hop's straight run on both sides, which a point on a
/// split between two segments does not have. The tolerance is the float slack
/// `segment_intersection` already allowed the whole run. A run of one segment
/// was cleared by the intersection itself, in the jumping segment's own terms,
/// so it is not measured again.
fn segment_carrying(
    path: &[Point],
    run: &Run,
    point: Point,
    clearance_checked: bool,
) -> Option<Carried> {
    for segment in run.first..=run.last {
        let (Some(&a), Some(&b)) = (path.get(segment), path.get(segment.saturating_add(1))) else {
            return None;
        };
        let length = hypot(b.x - a.x, b.y - a.y);
        if length == 0.0 {
            continue;
        }
        if !clearance_checked {
            let along = ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length;
            let slack = END_CLEARANCE_PX - 1e-9;
            if along < slack || length - along < slack {
                continue;
            }
        }
        let t = hypot(point.x - a.x, point.y - a.y) / length;
        return Some(Carried { crossing: Crossing { point, t }, segment, length });
    }
    None
}

/// The crossings that can each carry their own arc, in order along the
/// segment, at most `limit` of them. Hops closer than a diameter cannot fit as
/// separate arcs; the first crossing keeps its hop.
pub(super) fn spaced_hops(
    mut crossings: Vec<Crossing>,
    segment_length: f64,
    segment: usize,
    limit: usize,
) -> Vec<JumpPoint> {
    crossings.sort_by(|p, q| compare_numbers(p.t, q.t));
    let mut kept = Vec::new();
    let mut last_kept_t = f64::NEG_INFINITY;
    for Crossing { point, t } in crossings {
        if kept.len() >= limit {
            break;
        }
        if (t - last_kept_t) * segment_length < 2.0 * EDGE_JUMP_RADIUS_PX {
            continue;
        }
        last_kept_t = t;
        kept.push(JumpPoint { segment, x: point.x, y: point.y });
    }
    kept
}

/// Where `run`'s crossings with the earlier runs `candidates` land: on the
/// run's own segments, grouped to be spaced, or, where the run has no room for
/// the arc, handed to the earlier edge through `hand_over`.
pub(super) fn place_crossings(
    paths: &[&[Point]],
    run: &Run,
    candidates: &[Run],
    mut hand_over: impl FnMut(usize, Carried),
) -> OnSegment {
    let own = paths.get(run.edge).copied().unwrap_or_default();
    let mut on_segment = OnSegment::new();
    for other in candidates {
        let Some(point) =
            segment_intersection(run.placed.a, run.placed.b, other.placed.a, other.placed.b)
        else {
            continue;
        };
        let Some(here) = segment_carrying(own, run, point, run.first == run.last) else {
            let theirs = paths.get(other.edge).copied().unwrap_or_default();
            if let Some(there) = segment_carrying(theirs, other, point, false) {
                hand_over(other.edge, there);
            }
            continue;
        };
        let entry = on_segment.entry(here.segment).or_insert_with(|| (Vec::new(), here.length));
        entry.0.push(here.crossing);
    }
    on_segment
}

/// The earlier edge `id` (drawn along `path`) takes a crossing its successor
/// has no room to hop. Its hops on that segment are spaced again with the new
/// one, and kept only if the new one is a hop of its own rather than part of a
/// neighbour's, and the scene's `left` hops pay for it.
pub(super) fn hand_over_hop<'a>(
    result: &mut JsMap<&'a str, Vec<JumpPoint>>,
    left: &mut usize,
    id: &'a str,
    path: &[Point],
    there: Carried,
) {
    let existing = result.get(&id).cloned().unwrap_or_default();
    let Some(&start) = path.get(there.segment) else { return };
    let mut crossings: Vec<Crossing> = existing
        .iter()
        .filter(|jump| jump.segment == there.segment)
        .map(|jump| Crossing {
            point: Point { x: jump.x, y: jump.y },
            t: hypot(jump.x - start.x, jump.y - start.y) / there.length,
        })
        .collect();
    let held = crossings.len();
    crossings.push(there.crossing);
    let hops = spaced_hops(crossings, there.length, there.segment, MAX_HOPS_PER_SEGMENT);
    let Some(added) = hops.len().checked_sub(held).filter(|&added| added > 0 && added <= *left)
    else {
        return;
    };
    *left = left.saturating_sub(added);
    let mut jumps: Vec<JumpPoint> =
        existing.into_iter().filter(|jump| jump.segment != there.segment).chain(hops).collect();
    jumps.sort_by_key(|jump| jump.segment);
    result.set(id, jumps);
}
