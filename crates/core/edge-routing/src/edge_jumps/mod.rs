//! Line jumps (canvas-render's `layout/edges/edge-jumps.ts`): where one routed
//! edge crosses an EARLIER one in document order, the later edge, the one
//! painted on top, hops over it. Pure segment-pair intersection over
//! already-routed polylines; rounded corners re-use the same points, since a
//! curved route travels the orthogonal waypoints.
//!
//! A crossing is looked for between straight RUNS, an edge's consecutive
//! collinear segments, so one on a waypoint the router kept on a straight line
//! is found. If the later edge has no room for the arc there (the waypoint is
//! ITS split) the earlier edge hops instead: either line reads as crossing the
//! other, and a plain crossing is the worse picture. The broad phase that
//! finds which runs can meet is [`grid`].

pub mod grid;
mod hops;

use whiteboard_det::math::js_sign;

use crate::geometry::Point;
use crate::js_map::JsMap;
use grid::{Placed, SegmentGrid, place};

/// Most hops one segment draws. Every crossing that fits its own arc is
/// otherwise kept, so a crossing-dense board grows its hop list with the
/// product of its edges; past a cap the remaining crossings draw no arc, which
/// reads as a plain crossing rather than as a wrong one.
pub const MAX_HOPS_PER_SEGMENT: usize = 64;

/// Most hops one scene draws, for the same reason.
pub const MAX_HOPS_PER_SCENE: usize = 4096;

/// A hop: the point it is drawn over, on the path segment `segment` (from
/// path point `segment` to the next).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JumpPoint {
    pub segment: usize,
    pub x: f64,
    pub y: f64,
}

/// A routed edge as the jumps read it: its id and its drawn path.
#[derive(Debug, Clone, Copy)]
pub struct EdgePath<'a> {
    pub id: &'a str,
    pub path: &'a [Point],
}

/// A straight run of an edge, filed: the first and last path segment it
/// covers, and where the grid placed its two ends.
#[derive(Debug, Clone, Copy)]
struct Run {
    edge: usize,
    first: usize,
    last: usize,
    placed: Placed,
}

/// Whether `q` carries on from `p` to `r` along one axis-aligned line, forward.
/// Exact comparisons only: a cross product at a board's far extremes rounds,
/// and a waypoint the router kept on a straight line is always axis-aligned.
#[expect(clippy::float_cmp, reason = "the TypeScript compares with ===")]
fn continues_straight(p: Point, q: Point, r: Point) -> bool {
    if p.x == q.x && q.x == r.x {
        return js_sign(q.y - p.y) * js_sign(r.y - q.y) > 0.0;
    }
    if p.y == q.y && q.y == r.y {
        return js_sign(q.x - p.x) * js_sign(r.x - q.x) > 0.0;
    }
    false
}

/// Whether the path runs straight on through point `at`.
fn straight_through(path: &[Point], at: usize) -> bool {
    match (
        at.checked_sub(1).and_then(|i| path.get(i)),
        path.get(at),
        path.get(at.saturating_add(1)),
    ) {
        (Some(&p), Some(&q), Some(&r)) => continues_straight(p, q, r),
        _ => false,
    }
}

/// An edge's straight runs, each filed, or `None` for one no crossing can use.
/// A non-finite point cannot be drawn, and [`place`] files no run touching one:
/// its extent is NaN or infinite.
fn placed_runs_of(path: &[Point], edge: usize) -> Vec<Option<Run>> {
    let mut runs = Vec::new();
    let mut first: usize = 0;
    // The last point never runs straight on, so a run ends by then.
    while let Some(end) =
        (first.saturating_add(1)..path.len()).find(|&at| !straight_through(path, at))
    {
        let (Some(&a), Some(&b)) = (path.get(first), path.get(end)) else { break };
        let last = end.saturating_sub(1);
        runs.push(place(a, b).map(|placed| Run { edge, first, last, placed }));
        first = end;
    }
    runs
}

/// The scene's hops so far, and how many more it may draw.
struct Hops<'a> {
    result: JsMap<&'a str, Vec<JumpPoint>>,
    left: usize,
}

/// One edge's hops over the runs filed before it, its runs then filed in turn.
fn jump_edge<'a>(
    edges: &[EdgePath<'a>],
    paths: &[&[Point]],
    (e, runs): (usize, &[Option<Run>]),
    grid: &mut SegmentGrid,
    filed: &mut Vec<Run>,
    hops: &mut Hops<'a>,
) {
    let reached: Vec<_> = runs.iter().map(|run| run.map(|run| grid.reach(&run.placed))).collect();
    let mut jumps = Vec::new();
    for (run, reach) in runs.iter().zip(&reached) {
        let (Some(run), Some(reach)) = (run, reach) else { continue };
        if hops.left == 0 {
            continue;
        }
        let Some(found) = grid.candidates(reach) else {
            // The work budget is spent: no further hops anywhere in the scene.
            hops.left = 0;
            continue;
        };
        let candidates: Vec<Run> = found.iter().filter_map(|&i| filed.get(i).copied()).collect();
        let on_segment = hops::place_crossings(paths, run, &candidates, |target, there| {
            let Some(edge) = edges.get(target) else { return };
            hops::hand_over_hop(&mut hops.result, &mut hops.left, edge.id, edge.path, there);
        });
        for (segment, (crossings, length)) in on_segment {
            let limit = MAX_HOPS_PER_SEGMENT.min(hops.left);
            let spaced = hops::spaced_hops(crossings, length, segment, limit);
            hops.left = hops.left.saturating_sub(spaced.len());
            jumps.extend(spaced);
        }
    }
    if let (false, Some(edge)) = (jumps.is_empty(), edges.get(e)) {
        hops.result.set(edge.id, jumps);
    }
    for (run, reach) in runs.iter().zip(&reached) {
        if let (Some(run), Some(reach)) = (run, reach) {
            grid.add(reach);
            filed.push(*run);
        }
    }
}

/// Hop points for each edge over every EARLIER edge, by edge id in the order
/// each was first given one. Jumps on one segment are ordered along its
/// direction.
#[must_use]
pub fn compute_edge_jumps<'a>(edges: &[EdgePath<'a>]) -> Vec<(&'a str, Vec<JumpPoint>)> {
    let paths: Vec<&[Point]> = edges.iter().map(|edge| edge.path).collect();
    let placed: Vec<Vec<Option<Run>>> =
        paths.iter().enumerate().map(|(e, path)| placed_runs_of(path, e)).collect();
    let mut grid = SegmentGrid::new(placed.iter().flatten().flatten().map(|run| &run.placed));
    let mut filed = Vec::new();
    let mut hops = Hops { result: JsMap::default(), left: MAX_HOPS_PER_SCENE };
    for (e, runs) in placed.iter().enumerate() {
        if hops.left == 0 {
            break;
        }
        jump_edge(edges, &paths, (e, runs), &mut grid, &mut filed, &mut hops);
    }
    hops.result.iter().map(|(id, jumps)| (*id, jumps.clone())).collect()
}
