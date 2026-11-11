//! The sketch ink decomposition of a polyline: the primitives a stroke is made
//! of, and the edge's pencilled passes.
//!
//! Two contracts a consumer may rely on:
//!
//! - Every coordinate a stroke names lies within the primitive's own bounds
//!   plus `SKETCH_INK_REACH_PX`: end points are displaced by at most
//!   `JITTER_PX` per axis, a closing corner overshoots by `OVERSHOOT_PX` along
//!   its side, and a quadratic's control point sits at most `BOW_MAX_PX` off
//!   its chord, and a quadratic never leaves the triangle of its three points.
//! - The randomness is `StyleRandom::new(seed)` and nothing else, consumed in
//!   one fixed order with no positional input: the same seed on a moved box
//!   draws the same ink moved.
//!
//! Two passes per outline, slightly different, is what reads as pencil rather
//! than a shaky single line. Each pass is ONE continuous sub-path whose
//! vertices are displaced once and shared by the sides that meet there, so a
//! corner is a join rather than a gap between two independently shaken ends.

use crate::edge_arrows::ArrowPolygon;
use crate::edge_flatten::flatten_drawn_edge_path;
use whiteboard_det::format::js_number_to_string;
use whiteboard_det::math::{hypot, js_min, js_round};
use whiteboard_det::rng::StyleRandom;
use whiteboard_scene::{EdgeJumpPoint, ScenePoint};

use super::SKETCH_PASSES;

/// End-point displacement per axis, plus or minus.
pub(super) const JITTER_PX: f64 = 1.2;
/// Control-point offset off the chord per px of segment length, plus or minus.
const BOW_PER_PX: f64 = 0.012;
/// The bow's ceiling, so a wall-sized frame does not sag into its members.
const BOW_MAX_PX: f64 = 6.0;
/// How far a closed outline runs past its start along the last side.
const OVERSHOOT_PX: f64 = 3.0;
/// A curve is inked from sampled chords whose control point sits on the TRUE
/// arc, so the quadratic follows the rim instead of scalloping between
/// vertices; the hand's unsteadiness is then a small offset on top.
pub(super) const CURVE_JITTER_PX: f64 = 0.7;
pub(super) const CURVE_BOW_PX: f64 = 0.8;
/// Along a straight run of an edge, ink is re-anchored this often.
const EDGE_STEP_PX: f64 = 24.0;
/// A vertex closer than this to a neighbour is shaken proportionally less: a
/// hop is nine samples over ten pixels, and full displacement on each would
/// turn the arc into a burr.
const FULL_SHAKE_SPACING_PX: f64 = 12.0;
/// Hatch lines are lighter than the outline and barely bowed.
pub(super) const HATCH_BOW_PX: f64 = 0.6;

/// A coordinate as a stroke writes it: two places, and `-0` as `0` (which
/// `js_number_to_string` does).
pub(super) fn coordinate(value: f64) -> String {
    js_number_to_string(js_round(value * 100.0) / 100.0)
}

fn unit_offset(rng: &mut StyleRandom, amount: f64) -> f64 {
    (rng.next_unit() * 2.0 - 1.0) * amount
}

/// The control point of a bowed quadratic over the chord `a` to `b`: at most
/// `bow` off it.
fn bowed(rng: &mut StyleRandom, a: ScenePoint, b: ScenePoint, bow: f64) -> (f64, f64) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len = hypot(dx, dy);
    let t = 0.35 + rng.next_unit() * 0.3;
    let off = unit_offset(rng, bow);
    let nx = if len == 0.0 { 0.0 } else { -dy / len };
    let ny = if len == 0.0 { 0.0 } else { dx / len };
    (a.x + dx * t + nx * off, a.y + dy * t + ny * off)
}

/// One jittered stroke from `a` to `b`: displaced ends, a bowed quadratic between.
pub(super) fn jittered(
    rng: &mut StyleRandom,
    a: ScenePoint,
    b: ScenePoint,
    jitter: f64,
    bow: f64,
) -> String {
    let ax = a.x + unit_offset(rng, jitter);
    let ay = a.y + unit_offset(rng, jitter);
    let bx = b.x + unit_offset(rng, jitter);
    let by = b.y + unit_offset(rng, jitter);
    let (cx, cy) = bowed(rng, a, b, bow);
    format!(
        "M {} {} Q {} {} {} {}",
        coordinate(ax),
        coordinate(ay),
        coordinate(cx),
        coordinate(cy),
        coordinate(bx),
        coordinate(by)
    )
}

/// A side's bow amplitude: proportional to its length, capped.
fn side_bow(a: ScenePoint, b: ScenePoint) -> f64 {
    js_min(BOW_MAX_PX, hypot(b.x - a.x, b.y - a.y) * BOW_PER_PX)
}

/// The distance between two vertices of a path, or infinity past its ends.
fn gap(points: &[ScenePoint], i: usize, j: usize) -> f64 {
    match (points.get(i), points.get(j)) {
        (Some(a), Some(b)) => hypot(b.x - a.x, b.y - a.y),
        _ => f64::INFINITY,
    }
}

/// One displaced copy of each vertex, shared by the segments meeting there.
/// The displacement shrinks with the vertex's spacing from its neighbours, so
/// a densely sampled curve keeps its shape.
pub(super) fn shaken(
    rng: &mut StyleRandom,
    points: &[ScenePoint],
    amount: f64,
    closed: bool,
) -> Vec<ScenePoint> {
    let n = points.len();
    let last = n.saturating_sub(1);
    points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let before = if i > 0 {
                gap(points, i.saturating_sub(1), i)
            } else if closed && n > 1 {
                gap(points, last, i)
            } else {
                f64::INFINITY
            };
            let after = if i < last {
                gap(points, i, i.saturating_add(1))
            } else if closed && n > 1 {
                gap(points, i, 0)
            } else {
                f64::INFINITY
            };
            let scale = js_min(1.0, js_min(before, after) / FULL_SHAKE_SPACING_PX);
            let x = p.x + unit_offset(rng, amount) * scale;
            let y = p.y + unit_offset(rng, amount) * scale;
            ScenePoint { x, y }
        })
        .collect()
}

/// A straight-sided polyline (closed when `close`) as ONE continuous path: the
/// vertices displaced once, a bowed quadratic per side between them, and, when
/// closed, a last side that runs `OVERSHOOT_PX` past the start.
pub(super) fn stroke_polyline(rng: &mut StyleRandom, points: &[ScenePoint], close: bool) -> String {
    let n = points.len();
    let shook = shaken(rng, points, JITTER_PX, close);
    let Some(start) = shook.first() else { return String::new() };
    let mut parts = vec![format!("M {} {}", coordinate(start.x), coordinate(start.y))];
    let sides = if close { n } else { n.saturating_sub(1) };
    for i in 0..sides {
        let next = i.saturating_add(1).checked_rem(n).unwrap_or(0);
        let (Some(&a), Some(&b), Some(&end)) = (points.get(i), points.get(next), shook.get(next))
        else {
            continue;
        };
        let (cx, cy) = bowed(rng, a, b, side_bow(a, b));
        let mut to = end;
        if close && i.saturating_add(1) == sides {
            let len = hypot(b.x - a.x, b.y - a.y);
            if len > 0.0 {
                to = ScenePoint {
                    x: to.x + ((b.x - a.x) / len) * OVERSHOOT_PX,
                    y: to.y + ((b.y - a.y) / len) * OVERSHOOT_PX,
                };
            }
        }
        parts.push(format!(
            "Q {} {} {} {}",
            coordinate(cx),
            coordinate(cy),
            coordinate(to.x),
            coordinate(to.y)
        ));
    }
    parts.join(" ")
}

/// Every vertex the flattener produced (a rounded corner's chords, a hop's
/// samples) plus an anchor every `EDGE_STEP_PX` along any longer straight run.
/// Keeping one point per step would erase both: a hop is nine points over ten
/// pixels and a short stub is one bend inside the step, so a sketched edge
/// would cross other edges flat and cut its own corners.
fn anchored(points: &[ScenePoint]) -> Vec<ScenePoint> {
    let mut out = Vec::with_capacity(points.len());
    let mut previous: Option<ScenePoint> = None;
    for &p in points {
        if let Some(prev) = previous {
            let pieces = (hypot(p.x - prev.x, p.y - prev.y) / EDGE_STEP_PX).floor();
            // ponytail: at most MAX_ANCHORS_PER_RUN anchors a run (a run over
            // 25 million px); an unbounded count is an infinite loop for a run
            // of infinite length. A real board is far under it.
            let anchors = (1u32..)
                .take(MAX_ANCHORS_PER_RUN)
                .map(f64::from)
                .take_while(|k| *k < pieces)
                .map(|k| {
                    let t = k / pieces;
                    ScenePoint { x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t }
                });
            out.extend(anchors);
        }
        out.push(p);
        previous = Some(p);
    }
    out
}

/// The most anchors one straight run is given.
const MAX_ANCHORS_PER_RUN: usize = 1 << 20;

pub struct SketchEdgeOptions<'a> {
    /// Arrowheads to ink as wing strokes, in place of markers.
    pub arrows: &'a [ArrowPolygon],
    pub rounded: bool,
    pub jumps: &'a [EdgeJumpPoint],
}

/// The ink of one routed edge: the SAME drawn polyline the hit-test flattens
/// (rounded corners and jump hops included), with an anchor every
/// `EDGE_STEP_PX` along its straight runs, drawn in two bowed passes, then each
/// arrowhead as two wing strokes from the tip.
#[must_use]
pub fn sketch_edge(path: &[ScenePoint], seed: u32, options: &SketchEdgeOptions<'_>) -> Vec<String> {
    if path.len() < 2 || path.iter().any(|p| !p.x.is_finite() || !p.y.is_finite()) {
        return Vec::new();
    }
    let mut rng = StyleRandom::new(seed);
    let drawn = anchored(&flatten_drawn_edge_path(path, options.jumps, options.rounded));
    let mut strokes: Vec<String> =
        (0..SKETCH_PASSES).map(|_| stroke_polyline(&mut rng, &drawn, false)).collect();
    for arrow in options.arrows {
        let [tip, left, right] = arrow.points;
        strokes.push(jittered(&mut rng, tip, left, JITTER_PX, HATCH_BOW_PX));
        strokes.push(jittered(&mut rng, tip, right, JITTER_PX, HATCH_BOW_PX));
    }
    strokes
}
