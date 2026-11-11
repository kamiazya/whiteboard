//! The extent of a scene: the union box of everything it draws, and the box a
//! document of it is drawn in.

use crate::edge_arrows::edge_arrow_polygons;
use crate::glow::glow_reach_px;
use crate::ink::SKETCH_INK_REACH_PX;
use crate::legend_geometry::{LEGEND_MARGIN_PX, legend_panel_size};
use crate::scene_walk::SceneWalk;
use whiteboard_det::math::{js_max, js_min};
use whiteboard_scene::{BoundingBox, ResolvedEdgeNode, Scene, SceneNode};

/// The minimum extent any axis of a `scene_bounds` result is clamped to. A
/// zero-area viewBox is what resvg degenerates on, so a collapsed axis is
/// widened to this value rather than emitted as it is.
pub const MIN_SCENE_EXTENT_PX: f64 = 1.0;

/// The halo pill a text run's `halo` adds around its box, in px.
pub const TEXT_HALO_PAD_PX: f64 = 2.0;

/// The bounds of a scene that contributes no finite geometry at all.
const FALLBACK_BOUNDS: BoundingBox = BoundingBox { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };

#[derive(Debug, Clone, Copy)]
struct Extent {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

/// `extent` widened to cover the edge pair; none seeds from the pair.
fn widen(extent: Option<Extent>, x0: f64, y0: f64, x1: f64, y1: f64) -> Extent {
    match extent {
        None => Extent { min_x: x0, min_y: y0, max_x: x1, max_y: y1 },
        Some(e) => Extent {
            min_x: js_min(e.min_x, x0),
            min_y: js_min(e.min_y, y0),
            max_x: js_max(e.max_x, x1),
            max_y: js_max(e.max_y, y1),
        },
    }
}

/// A box's possibly-negative width and height as a min and max edge pair;
/// none for a box with a non-finite field.
fn box_edges(bbox: &BoundingBox) -> Option<(f64, f64, f64, f64)> {
    let BoundingBox { x, y, w, h } = *bbox;
    if ![x, y, w, h].iter().all(|v| v.is_finite()) {
        return None;
    }
    let (corner_x, corner_y) = (x + w, y + h);
    Some((js_min(x, corner_x), js_min(y, corner_y), js_max(x, corner_x), js_max(y, corner_y)))
}

/// The x-shift a node applies to its own subtree. Only a list item and a table
/// cell emit a transform, translating by their own `x`, so their descendants
/// are stored relative to the wrapper and must be re-offset to land where they
/// are drawn. A non-finite `x` contributes no shift rather than poisoning the
/// whole subtree.
fn subtree_offset_x(node: SceneWalk<'_>) -> f64 {
    match node {
        SceneWalk::Item(_) | SceneWalk::Cell(_) => match node.bbox() {
            Some(bbox) if bbox.x.is_finite() => bbox.x,
            _ => 0.0,
        },
        _ => 0.0,
    }
}

/// How far a node's DECORATION reaches beyond its own geometry: ink is bounded
/// by a declared constant, a glow by its radius and a run's halo pill by its
/// pad, so a derived viewBox never clips them.
fn decoration_reach_px(node: SceneWalk<'_>) -> f64 {
    let ink = if node.ink().is_some() { SKETCH_INK_REACH_PX } else { 0.0 };
    let glow =
        node.appearance().map_or(0.0, |a| glow_reach_px(a.glow.map_or(0.0, |g| g.radius_px)));
    let halo = node
        .text_run()
        .and_then(|run| run.appearance.as_ref())
        .and_then(|a| a.halo.as_deref())
        .is_some_and(|halo| !halo.is_empty());
    js_max(js_max(ink, glow), if halo { TEXT_HALO_PAD_PX } else { 0.0 })
}

/// An edge's polyline plus the arrowhead wings, which reach beyond it. The
/// wings come from the shared geometry so this walk agrees with what the SVG
/// backend draws, and they take no reach of their own.
fn widen_by_edge(
    extent: Option<Extent>,
    edge: &ResolvedEdgeNode,
    offset_x: f64,
    reach: f64,
) -> Option<Extent> {
    let mut next = extent;
    for p in edge.path.iter().filter(|p| p.x.is_finite() && p.y.is_finite()) {
        let x = p.x + offset_x;
        next = Some(widen(next, x - reach, p.y - reach, x + reach, p.y + reach));
    }
    for arrow in edge_arrow_polygons(edge) {
        for p in arrow.points.iter().filter(|p| p.x.is_finite() && p.y.is_finite()) {
            let x = p.x + offset_x;
            next = Some(widen(next, x, p.y, x, p.y));
        }
    }
    next
}

fn widen_by_box(
    extent: Option<Extent>,
    bbox: &BoundingBox,
    offset_x: f64,
    reach: f64,
) -> Option<Extent> {
    match box_edges(bbox) {
        None => extent,
        Some((x0, y0, x1, y1)) => Some(widen(
            extent,
            x0 + offset_x - reach,
            y0 - reach,
            x1 + offset_x + reach,
            y1 + reach,
        )),
    }
}

/// The union box of every resolved node box in the scene, edge polyline points
/// included, walked at every depth with an explicit stack so a pathologically
/// deep embed chain cannot overflow the call stack.
///
/// Total: an empty scene, an all-zero-size scene or one with only non-finite
/// geometry yields the documented fallback or clamped result rather than NaN,
/// infinity or a zero-area box.
#[must_use]
pub fn scene_bounds(scene: &Scene) -> BoundingBox {
    let mut extent: Option<Extent> = None;
    // Each frame carries the accumulated x-shift of its ancestors' transforms,
    // so nested wrappers compose exactly as nested `<g transform>` elements do.
    let mut stack: Vec<(SceneWalk<'_>, f64)> =
        scene.nodes.iter().map(|node| (SceneWalk::Node(node), 0.0)).collect();
    while let Some((node, offset_x)) = stack.pop() {
        let reach = decoration_reach_px(node);
        extent = match node {
            SceneWalk::Node(SceneNode::Edge(edge)) => widen_by_edge(extent, edge, offset_x, reach),
            _ => node.bbox().map_or(extent, |bbox| widen_by_box(extent, bbox, offset_x, reach)),
        };
        let child_offset_x = offset_x + subtree_offset_x(node);
        stack.extend(node.children().into_iter().map(|child| (child, child_offset_x)));
    }
    let Some(e) = extent else { return FALLBACK_BOUNDS };
    BoundingBox {
        x: e.min_x,
        y: e.min_y,
        w: js_max(e.max_x - e.min_x, MIN_SCENE_EXTENT_PX),
        h: js_max(e.max_y - e.min_y, MIN_SCENE_EXTENT_PX),
    }
}

/// The box a DOCUMENT of this scene is drawn in: the scene's bounds, plus room
/// BELOW the content for the legend when the scene carries one (ADR-0040
/// decision 6). The legend sits at the content's left edge under the drawing
/// rather than in a band beside it, so it never widens a picture by the width
/// of its longest value. The scene's own bounds, which the digest, the drawing
/// score and the editor read, are untouched.
#[must_use]
pub fn scene_document_bounds(scene: &Scene) -> BoundingBox {
    let bounds = scene_bounds(scene);
    let Some(legend) = &scene.legend else { return bounds };
    let (panel_w, panel_h) = legend_panel_size(legend);
    if panel_w.to_bits() == 0.0f64.to_bits() {
        return bounds;
    }
    BoundingBox {
        x: bounds.x,
        y: bounds.y,
        w: js_max(bounds.w, panel_w + LEGEND_MARGIN_PX * 2.0),
        h: bounds.h + panel_h + LEGEND_MARGIN_PX * 2.0,
    }
}
