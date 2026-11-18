//! The SVG a layout answers beside its scene when the request asks for one
//! (`svg`): the laid-out scene drawn by `whiteboard-canvas-render`'s backend,
//! as the document or its keyed projection, so a picture is one call rather
//! than a layout and a TypeScript serialization of the scene it answered.

use whiteboard_canvas_render::scene_bounds::{scene_bounds, scene_document_bounds};
use whiteboard_canvas_render::svg::{
    KeyedSvgRender, SvgDocumentOptions, render_scene_to_keyed_svg, render_scene_to_svg,
};
use whiteboard_det::math::js_max;
use whiteboard_scene::{BoundingBox, Scene};

use super::request::{SvgAsk, ViewBox};

/// The most bytes an answered SVG may hold. The answer crosses as one JSON
/// text that the host decodes into one string, and V8 holds a string of at
/// most 2^29 - 24 UTF-16 units; JSON spells a byte in at most six (`\u001f`),
/// so 64 MiB keeps even the worst-escaped answer under that with the scene
/// beside it. Past it the layout is refused, never cut short: a truncated
/// document is not an SVG. A keyed answer is held to the same bytes, counted
/// as the document its groups make.
pub const MAX_SVG_BYTES: usize = 64 * 1024 * 1024;

/// Why no SVG is answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Unrendered {
    /// A number in the scene the document cannot spell.
    NonFinite,
    /// A document past the bytes the answer may carry.
    TooLarge,
}

/// The SVG an ask answers: the document, or its keyed projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Drawn {
    Document(String),
    Keyed(KeyedSvgRender),
}

/// `bounds` grown by `margin` on every side, as `sceneDocumentBounds` grows
/// it: a margin that is not finite and positive grows it by nothing.
fn grown(bounds: BoundingBox, margin: Option<f64>) -> BoundingBox {
    let m = margin.filter(|m| m.is_finite()).map_or(0.0, |m| js_max(m, 0.0));
    BoundingBox { x: bounds.x - m, y: bounds.y - m, w: bounds.w + m * 2.0, h: bounds.h + m * 2.0 }
}

fn view_box(scene: &Scene, ask: ViewBox) -> BoundingBox {
    match ask {
        ViewBox::Document if scene.nodes.is_empty() => {
            BoundingBox { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }
        }
        ViewBox::Document => scene_document_bounds(scene),
        ViewBox::Bounds { document: true, margin } => grown(scene_document_bounds(scene), margin),
        ViewBox::Bounds { document: false, margin } => grown(scene_bounds(scene), margin),
    }
}

/// `scene` as the SVG `ask` describes, refused past `max` bytes.
pub(super) fn render(scene: &Scene, ask: &SvgAsk, max: usize) -> Result<Drawn, Unrendered> {
    let options = SvgDocumentOptions {
        width: ask.width,
        height: ask.height,
        view_box: ask.view_box.map(|which| view_box(scene, which)),
        padding: ask.padding,
        background: ask.background.clone(),
        text_fill: ask.text_fill.clone(),
        omit_legend: ask.omit_legend,
        raster_scale: ask.raster_scale,
    };
    let drawn = if ask.keyed {
        render_scene_to_keyed_svg(scene, Some(&options)).map(Drawn::Keyed)
    } else {
        render_scene_to_svg(scene, Some(&options)).map(Drawn::Document)
    };
    let drawn = drawn.map_err(|_| Unrendered::NonFinite)?;
    let bytes = match &drawn {
        Drawn::Document(svg) => svg.len(),
        Drawn::Keyed(keyed) => keyed.svg.len(),
    };
    if bytes > max {
        return Err(Unrendered::TooLarge);
    }
    Ok(drawn)
}
