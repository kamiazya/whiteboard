//! The sketch ink of a node's chrome: the silhouette as strokes, and the
//! hatch a coloured node is filled with.

use super::SKETCH_PASSES;
use super::sketch::{
    CURVE_BOW_PX, CURVE_JITTER_PX, HATCH_BOW_PX, coordinate, jittered, shaken, stroke_polyline,
};
use crate::finite_box::is_finite_box;
use whiteboard_det::math::{cos, hypot, js_max, js_min, sin};
use whiteboard_det::rng::StyleRandom;
use whiteboard_scene::{BoundingBox, NodeOutline, ScenePoint};

/// Points per half-ellipse arc.
const ARC_SAMPLES: u32 = 12;
/// Points around a whole ellipse.
const ELLIPSE_SAMPLES: u32 = 24;
const HATCH_GAP_PX: f64 = 6.0;
const HATCH_ANGLE: f64 = (-41.0 * core::f64::consts::PI) / 180.0;
/// Each box hatches at its own slant near the base, plus or minus this, and its
/// own gap, plus or minus this share.
const HATCH_ANGLE_SPREAD: f64 = (10.0 * core::f64::consts::PI) / 180.0;
const HATCH_GAP_SPREAD: f64 = 0.25;
/// Hatch lines are lighter than the outline and barely displaced.
const HATCH_JITTER_PX: f64 = 0.5;

#[derive(Debug, Clone, PartialEq)]
pub struct SketchInk {
    /// Outline strokes, one path per pass.
    pub strokes: Vec<String>,
    /// Hatch fill lines, present only when asked for and the shape has an area.
    pub hatch: Option<Vec<String>>,
}

/// A sampled curve: vertices with the true midpoint of each chord.
struct Curve {
    points: Vec<ScenePoint>,
    mids: Vec<ScenePoint>,
    closed: bool,
}

/// One stroke of a silhouette: straight-sided (closed when it is the region
/// the outline encloses) or a sampled curve.
enum Stroke {
    Poly { points: Vec<ScenePoint>, closed: bool },
    Curve(Curve),
}

struct Silhouette {
    strokes: Vec<Stroke>,
    /// The convex region a hatch fills.
    region: Vec<ScenePoint>,
}

fn on_ellipse(cx: f64, cy: f64, rx: f64, ry: f64, angle: f64) -> ScenePoint {
    ScenePoint { x: cx + rx * cos(angle), y: cy + ry * sin(angle) }
}

fn ellipse_curve(cx: f64, cy: f64, rx: f64, ry: f64) -> Curve {
    let step = (core::f64::consts::PI * 2.0) / f64::from(ELLIPSE_SAMPLES);
    let at = |i: f64| on_ellipse(cx, cy, rx, ry, i * step);
    let indices = (0..ELLIPSE_SAMPLES).map(f64::from);
    Curve {
        points: indices.clone().map(at).collect(),
        mids: indices.map(|i| at(i + 0.5)).collect(),
        closed: true,
    }
}

/// A half-ellipse from angle `from` to `to`, inclusive of both ends.
fn arc_curve(cx: f64, cy: f64, rx: f64, ry: f64, from: f64, to: f64) -> Curve {
    let step = (to - from) / f64::from(ARC_SAMPLES);
    let at = |i: f64| on_ellipse(cx, cy, rx, ry, from + step * i);
    Curve {
        points: (0..=ARC_SAMPLES).map(|i| at(f64::from(i))).collect(),
        mids: (0..ARC_SAMPLES).map(|i| at(f64::from(i) + 0.5)).collect(),
        closed: false,
    }
}

fn rect_corners(bbox: &BoundingBox) -> Vec<ScenePoint> {
    let at = |x, y| ScenePoint { x, y };
    vec![
        at(bbox.x, bbox.y),
        at(bbox.x + bbox.w, bbox.y),
        at(bbox.x + bbox.w, bbox.y + bbox.h),
        at(bbox.x, bbox.y + bbox.h),
    ]
}

/// A cylinder: over the top cap, down the right side, under the bottom cap, up
/// the left side (the silhouette the crisp path draws), then the lid: the
/// visible lower half of the top cap, left to right.
fn cylinder_silhouette(x: f64, y: f64, w: f64, h: f64, ry: f64) -> Silhouette {
    let rx = w / 2.0;
    let cx = x + rx;
    let top = y + ry;
    let bottom = y + h - ry;
    let pi = core::f64::consts::PI;
    let over = arc_curve(cx, top, rx, ry, pi, 2.0 * pi);
    let under = arc_curve(cx, bottom, rx, ry, 0.0, pi);
    let lid = arc_curve(cx, top, rx, ry, pi, 0.0);
    let side = |x, from, to| Stroke::Poly {
        points: vec![ScenePoint { x, y: from }, ScenePoint { x, y: to }],
        closed: false,
    };
    let region = over.points.iter().chain(&under.points).copied().collect();
    Silhouette {
        strokes: vec![
            Stroke::Curve(over),
            side(x + w, top, bottom),
            Stroke::Curve(under),
            side(x, bottom, top),
            Stroke::Curve(lid),
        ],
        region,
    }
}

/// The closed polyline the outline is inked along, plus any open extra strokes
/// (the cylinder's lid). Rect corners ignore the radius: a hand does not draw a
/// 6px fillet.
fn silhouette_of(outline: Option<&NodeOutline>, bbox: &BoundingBox) -> Silhouette {
    match outline {
        None => {
            let corners = rect_corners(bbox);
            Silhouette {
                strokes: vec![Stroke::Poly { points: corners.clone(), closed: true }],
                region: corners,
            }
        }
        Some(NodeOutline::Polygon { points }) => Silhouette {
            strokes: vec![Stroke::Poly { points: points.clone(), closed: true }],
            region: points.clone(),
        },
        Some(NodeOutline::Ellipse { cx, cy, rx, ry }) => {
            let curve = ellipse_curve(*cx, *cy, *rx, *ry);
            let region = curve.points.clone();
            Silhouette { strokes: vec![Stroke::Curve(curve)], region }
        }
        Some(NodeOutline::Cylinder { x, y, w, h, ry }) => cylinder_silhouette(*x, *y, *w, *h, *ry),
    }
}

#[expect(
    clippy::manual_midpoint,
    reason = "`f64::midpoint` avoids the overflow `(a + b) / 2` has, which the TypeScript does not"
)]
/// One chord of a curve, from its already-displaced ends, with the control
/// point at the quadratic that passes through the arc's true midpoint
/// (`2*mid - (a+b)/2`), nudged.
fn curved_to(
    rng: &mut StyleRandom,
    a: ScenePoint,
    b: ScenePoint,
    mid: ScenePoint,
    to: ScenePoint,
) -> String {
    let cx = 2.0 * mid.x - (a.x + b.x) / 2.0 + (rng.next_unit() * 2.0 - 1.0) * CURVE_BOW_PX;
    let cy = 2.0 * mid.y - (a.y + b.y) / 2.0 + (rng.next_unit() * 2.0 - 1.0) * CURVE_BOW_PX;
    format!("Q {} {} {} {}", coordinate(cx), coordinate(cy), coordinate(to.x), coordinate(to.y))
}

fn stroke_curve(rng: &mut StyleRandom, curve: &Curve) -> String {
    let n = curve.points.len();
    let shook = shaken(rng, &curve.points, CURVE_JITTER_PX, curve.closed);
    let Some(start) = shook.first() else { return String::new() };
    let mut parts = vec![format!("M {} {}", coordinate(start.x), coordinate(start.y))];
    let chords = if curve.closed { n } else { n.saturating_sub(1) };
    for i in 0..chords {
        let next = i.saturating_add(1).checked_rem(n).unwrap_or(0);
        if let (Some(&a), Some(&b), Some(&mid), Some(&to)) =
            (curve.points.get(i), curve.points.get(next), curve.mids.get(i), shook.get(next))
        {
            parts.push(curved_to(rng, a, b, mid, to));
        }
    }
    parts.join(" ")
}

fn stroke_of(rng: &mut StyleRandom, stroke: &Stroke) -> String {
    match stroke {
        Stroke::Curve(curve) => stroke_curve(rng, curve),
        Stroke::Poly { points, closed } => stroke_polyline(rng, points, *closed),
    }
}

/// The signed area's sign of a polygon, which says which side is inward.
fn inward_sign(polygon: &[ScenePoint]) -> f64 {
    let area: f64 = polygon
        .iter()
        .zip(polygon.iter().cycle().skip(1))
        .fold(0.0, |sum, (a, b)| sum + (a.x * b.y - b.x * a.y));
    if area >= 0.0 { 1.0 } else { -1.0 }
}

/// Clips the infinite line through `origin` along `dir` to a convex polygon
/// (Cyrus-Beck). Outlines are convex by contract, so one entry and one exit is
/// all there is. None when the line misses.
fn clip_to_convex(
    origin: ScenePoint,
    dir: ScenePoint,
    polygon: &[ScenePoint],
) -> Option<(ScenePoint, ScenePoint)> {
    let sign = inward_sign(polygon);
    let mut t_enter = f64::NEG_INFINITY;
    let mut t_exit = f64::INFINITY;
    for (a, b) in polygon.iter().zip(polygon.iter().cycle().skip(1)) {
        // Inward normal of the edge for this winding.
        let nx = -(b.y - a.y) * sign;
        let ny = (b.x - a.x) * sign;
        let numerator = (origin.x - a.x) * nx + (origin.y - a.y) * ny;
        let denominator = dir.x * nx + dir.y * ny;
        if denominator == 0.0 {
            if numerator < 0.0 {
                return None;
            }
            continue;
        }
        let t = -numerator / denominator;
        if denominator > 0.0 {
            t_enter = js_max(t_enter, t);
        } else {
            t_exit = js_min(t_exit, t);
        }
        if t_enter > t_exit {
            return None;
        }
    }
    if !t_enter.is_finite() || !t_exit.is_finite() || t_exit - t_enter < 1.0 {
        return None;
    }
    let at = |t: f64| ScenePoint { x: origin.x + dir.x * t, y: origin.y + dir.y * t };
    Some((at(t_enter), at(t_exit)))
}

fn hatch_lines(rng: &mut StyleRandom, polygon: &[ScenePoint], bbox: &BoundingBox) -> Vec<String> {
    // One slant and one gap per box, from its own seed: ruling every node at
    // the same angle and pitch is what made the hatch read as machine-drawn.
    let angle = HATCH_ANGLE + (rng.next_unit() * 2.0 - 1.0) * HATCH_ANGLE_SPREAD;
    let gap = HATCH_GAP_PX * (1.0 + (rng.next_unit() * 2.0 - 1.0) * HATCH_GAP_SPREAD);
    let dir = ScenePoint { x: cos(angle), y: sin(angle) };
    let normal = ScenePoint { x: -dir.y, y: dir.x };
    let cx = bbox.x + bbox.w / 2.0;
    let cy = bbox.y + bbox.h / 2.0;
    let reach = hypot(bbox.w, bbox.h) / 2.0;
    // ponytail: at most MAX_HATCH_LINES lines a box (a box tens of millions of px
    // across); an unbounded count is an infinite loop for a box of infinite reach.
    std::iter::successors(Some(-reach), |offset| Some(offset + gap))
        .take(MAX_HATCH_LINES)
        .take_while(|offset| *offset <= reach)
        .filter_map(|offset| {
            let origin = ScenePoint { x: cx + normal.x * offset, y: cy + normal.y * offset };
            clip_to_convex(origin, dir, polygon)
        })
        .map(|(from, to)| jittered(rng, from, to, HATCH_JITTER_PX, HATCH_BOW_PX))
        .collect()
}

/// The most hatch lines one box is given.
const MAX_HATCH_LINES: usize = 1 << 20;

/// The ink of one node's chrome: `outline` as the shape table resolved it
/// (none for the rect), `bbox` its box, `seed` from the node's id. `hatch` asks
/// for a hatched fill, what a preset-coloured node gets instead of a flat tint.
#[must_use]
pub fn sketch_shape(
    outline: Option<&NodeOutline>,
    bbox: &BoundingBox,
    seed: u32,
    hatch: bool,
) -> SketchInk {
    if !is_finite_box(bbox) || bbox.w <= 0.0 || bbox.h <= 0.0 {
        return SketchInk { strokes: Vec::new(), hatch: None };
    }
    let mut rng = StyleRandom::new(seed);
    let silhouette = silhouette_of(outline, bbox);
    // Every pass draws the whole silhouette as ONE path, so a rect is two
    // strokes and a cylinder (caps, sides and lid) is two as well.
    let strokes = (0..SKETCH_PASSES)
        .map(|_| {
            let parts: Vec<String> =
                silhouette.strokes.iter().map(|stroke| stroke_of(&mut rng, stroke)).collect();
            parts.join(" ")
        })
        .collect();
    let hatch = hatch.then(|| hatch_lines(&mut rng, &silhouette.region, bbox));
    SketchInk { strokes, hatch }
}
