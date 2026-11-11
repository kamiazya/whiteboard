//! Arrowhead geometry shared by the SVG backend (which draws the triangles)
//! and `scene_bounds` (which must include their wings so a derived viewBox
//! never clips them). One producer keeps the two in agreement.
//!
//! Sizes are canvas units: arrowheads scale with the content under pan and
//! zoom exactly like stroke geometry does.

use whiteboard_det::math::{hypot, js_max};
use whiteboard_scene::{EdgeEnd, ResolvedEdgeNode, ScenePoint};

const ARROW_LENGTH: f64 = 10.0;
const ARROW_HALF_WIDTH: f64 = 4.0;
/// Below this segment length there is no usable direction, so no arrow.
const MIN_DIRECTION_LENGTH: f64 = 1e-6;
/// A head is never narrower than this many line widths. Up to the line width
/// where the fixed 8-unit head reaches it nothing changes, so every light line
/// draws as it always did; past it the head grows with the line.
const HEAD_WIDTHS_PER_LINE_WIDTH: f64 = 3.2;
/// SVG's initial `stroke-width`: what an edge with no weight of its own draws at.
const SVG_INITIAL_STROKE_WIDTH: f64 = 1.0;

fn line_width(edge: &ResolvedEdgeNode) -> f64 {
    match edge.appearance.as_ref().and_then(|a| a.stroke_width) {
        Some(width) if width.is_finite() && width > 0.0 => width,
        _ => SVG_INITIAL_STROKE_WIDTH,
    }
}

/// How much larger than the fixed head this edge's heads draw: 1 for a light line.
#[must_use]
pub fn edge_arrow_scale(edge: &ResolvedEdgeNode) -> f64 {
    js_max(1.0, (line_width(edge) * HEAD_WIDTHS_PER_LINE_WIDTH) / (ARROW_HALF_WIDTH * 2.0))
}

/// An arrowhead: the tip first, then the two wing corners, the SVG emission order.
#[derive(Debug, Clone, PartialEq)]
pub struct ArrowPolygon {
    pub points: [ScenePoint; 3],
}

fn arrow_at(tip: ScenePoint, inward: ScenePoint, scale: f64) -> Option<ArrowPolygon> {
    let dx = tip.x - inward.x;
    let dy = tip.y - inward.y;
    let length = hypot(dx, dy);
    if length < MIN_DIRECTION_LENGTH {
        return None;
    }
    let ux = dx / length;
    let uy = dy / length;
    let head_length = ARROW_LENGTH * scale;
    let half = ARROW_HALF_WIDTH * scale;
    let base_x = tip.x - ux * head_length;
    let base_y = tip.y - uy * head_length;
    // Perpendicular (-uy, ux); the corner order is fixed for determinism.
    Some(ArrowPolygon {
        points: [
            tip,
            ScenePoint { x: base_x - uy * half, y: base_y + ux * half },
            ScenePoint { x: base_x + uy * half, y: base_y - ux * half },
        ],
    })
}

/// A head in a marker's own viewport: the same triangle `arrow_at` places in
/// canvas space, so the backend can emit one `<marker>` per colour and size.
#[derive(Debug, Clone, PartialEq)]
pub struct MarkerGeometry {
    pub width: f64,
    pub height: f64,
    pub ref_x: f64,
    pub ref_y: f64,
    pub points: [ScenePoint; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkerDirection {
    Start,
    End,
}

/// `ref_x` and `ref_y` place the tip on the path endpoint `inset` units PAST
/// the vertex the marker is attached to, exactly where `arrow_at` puts it once
/// the backend has pulled the line's end back by `inset`.
#[must_use]
pub fn arrow_marker_geometry(direction: MarkerDirection, scale: f64, inset: f64) -> MarkerGeometry {
    let length = ARROW_LENGTH * scale;
    let half = ARROW_HALF_WIDTH * scale;
    let at = |x, y| ScenePoint { x, y };
    match direction {
        MarkerDirection::End => MarkerGeometry {
            width: length,
            height: half * 2.0,
            ref_x: length - inset,
            ref_y: half,
            points: [at(length, half), at(0.0, 0.0), at(0.0, half * 2.0)],
        },
        // A start arrow points AGAINST the outgoing segment, so its triangle
        // points -x rather than relying on `orient="auto-start-reverse"`,
        // whose resvg support is not established.
        MarkerDirection::Start => MarkerGeometry {
            width: length,
            height: half * 2.0,
            ref_x: inset,
            ref_y: half,
            points: [at(0.0, half), at(length, 0.0), at(length, half * 2.0)],
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeEndSide {
    From,
    To,
}

/// The first two and last two points of a path, or none when it has fewer
/// than two.
fn terminals(path: &[ScenePoint]) -> Option<(ScenePoint, ScenePoint, ScenePoint, ScenePoint)> {
    let (first, second) = (path.first()?, path.get(1)?);
    let (last, before) = (path.last()?, path.iter().rev().nth(1)?);
    Some((*first, *second, *last, *before))
}

/// How far the line's own end must stop short of an arrow tip so its butt end
/// hides under the head. The head narrows to nothing at the tip, so a line
/// drawn all the way there shows its corners either side of it. A light line
/// keeps its end (0), and so does a terminal run too short to shorten without
/// losing its direction.
#[must_use]
pub fn edge_arrow_inset(edge: &ResolvedEdgeNode, end: EdgeEndSide) -> f64 {
    if edge_arrow_scale(edge).to_bits() == 1.0f64.to_bits() {
        return 0.0;
    }
    let Some((first, second, last, before)) = terminals(&edge.path) else { return 0.0 };
    // Where the head is half a line wide: its half-width grows by
    // HALF_WIDTH per LENGTH back from the tip.
    let inset = ((line_width(edge) / 2.0) * ARROW_LENGTH) / ARROW_HALF_WIDTH;
    let (tip, inward) = match end {
        EdgeEndSide::To => (last, before),
        EdgeEndSide::From => (first, second),
    };
    let run = hypot(tip.x - inward.x, tip.y - inward.y);
    if run > inset + MIN_DIRECTION_LENGTH { inset } else { 0.0 }
}

/// Which ends of this edge get an arrowhead: the SAME rule that decides
/// whether `edge_arrow_polygons` yields a polygon for that end. An end with no
/// usable direction draws nothing as a polygon, while a marker on a degenerate
/// segment would paint an arrow at angle 0.
#[must_use]
pub fn edge_arrow_ends(edge: &ResolvedEdgeNode) -> (bool, bool) {
    let Some((first, second, last, before)) = terminals(&edge.path) else { return (false, false) };
    let from = edge.from_end == EdgeEnd::Arrow && arrow_at(first, second, 1.0).is_some();
    let to = edge.to_end == EdgeEnd::Arrow && arrow_at(last, before, 1.0).is_some();
    (from, to)
}

/// The arrowhead polygons of an edge, source arrow first. Total: a degenerate
/// path yields no polygon for the end that has no direction.
#[must_use]
pub fn edge_arrow_polygons(edge: &ResolvedEdgeNode) -> Vec<ArrowPolygon> {
    let Some((first, second, last, before)) = terminals(&edge.path) else { return Vec::new() };
    let scale = edge_arrow_scale(edge);
    let from = (edge.from_end == EdgeEnd::Arrow).then(|| arrow_at(first, second, scale));
    let to = (edge.to_end == EdgeEnd::Arrow).then(|| arrow_at(last, before, scale));
    from.into_iter().chain(to).flatten().collect()
}
