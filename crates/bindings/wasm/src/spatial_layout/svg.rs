//! The SVG a layout answers beside its scene when the request asks for one
//! (`svg`): the laid-out scene drawn by `whiteboard-canvas-render`'s backend,
//! so a server render is one call rather than a layout and a TypeScript
//! serialization of the scene it answered.

use whiteboard_canvas_render::scene_bounds::scene_document_bounds;
use whiteboard_canvas_render::svg::{SvgDocumentOptions, render_scene_to_svg};
use whiteboard_scene::{BoundingBox, Scene};

use super::request::{SvgAsk, ViewBox};

/// The most bytes an answered SVG may hold. The answer crosses as one JSON
/// text that the host decodes into one string, and V8 holds a string of at
/// most 2^29 - 24 UTF-16 units; JSON spells a byte in at most six (`\u001f`),
/// so 64 MiB keeps even the worst-escaped answer under that with the scene
/// beside it. Past it the layout is refused, never cut short: a truncated
/// document is not an SVG.
pub const MAX_SVG_BYTES: usize = 64 * 1024 * 1024;

/// Why no SVG is answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Unrendered {
    /// A number in the scene the document cannot spell.
    NonFinite,
    /// A document past the bytes the answer may carry.
    TooLarge,
}

fn view_box(scene: &Scene, ask: ViewBox) -> BoundingBox {
    match ask {
        ViewBox::Document if scene.nodes.is_empty() => {
            BoundingBox { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }
        }
        ViewBox::Document => scene_document_bounds(scene),
    }
}

/// `scene` as the SVG `ask` describes, refused past `max` bytes.
pub(super) fn render(scene: &Scene, ask: &SvgAsk, max: usize) -> Result<String, Unrendered> {
    let options = SvgDocumentOptions {
        view_box: ask.view_box.map(|which| view_box(scene, which)),
        padding: ask.padding,
        background: ask.background.clone(),
        text_fill: ask.text_fill.clone(),
        raster_scale: ask.raster_scale,
        ..SvgDocumentOptions::default()
    };
    let svg = render_scene_to_svg(scene, Some(&options)).map_err(|_| Unrendered::NonFinite)?;
    if svg.len() > max {
        return Err(Unrendered::TooLarge);
    }
    Ok(svg)
}
