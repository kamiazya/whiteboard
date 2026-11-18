//! The SVG a request asks to be answered with besides its scene (`svg`): the
//! envelope options the laid-out scene is drawn with, read as strictly as the
//! rest of the request. Its `viewBox` names no box, since the caller has no
//! scene to measure before the layout: `'document'` is the scene's document
//! bounds, an empty box for a scene that draws nothing (the server's
//! envelope), and `{of, margin?}` is the scene's bounds (`of: 'scene'`) or its
//! document bounds (`of: 'document'`) grown by `margin` on every side, exactly
//! as canvas-render's `sceneBounds` and `sceneDocumentBounds(scene, margin)`
//! answer them, their 1x1 fallback for an empty scene included (the web's
//! envelopes). `form: 'keyed'` answers the keyed projection instead of the
//! document.

use whiteboard_model::Value;

use crate::json_canvas_wire::{Fields, number_of, string_of};

/// Where an asked SVG's `viewBox` comes from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum ViewBox {
    /// The laid-out scene's document bounds (its legend's room included), or
    /// `0 0 0 0` for a scene with no node.
    Document,
    /// The scene's bounds, or its document bounds when `document`, grown by
    /// `margin` when it is finite and positive.
    Bounds { document: bool, margin: Option<f64> },
}

/// What an answer's SVG is drawn with: `render_scene_to_svg`'s envelope
/// options, each absent unless the caller set it, and the form it is answered in.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SvgAsk {
    pub(crate) view_box: Option<ViewBox>,
    pub(crate) width: Option<f64>,
    pub(crate) height: Option<f64>,
    pub(crate) padding: Option<f64>,
    pub(crate) background: Option<String>,
    pub(crate) text_fill: Option<String>,
    pub(crate) raster_scale: Option<f64>,
    /// The host draws the legend itself (`legend: 'omit'`).
    pub(crate) omit_legend: bool,
    /// The keyed projection (`form: 'keyed'`) rather than the document.
    pub(crate) keyed: bool,
}

fn bounds_of(value: &Value) -> Option<ViewBox> {
    let mut f = Fields::of(value)?;
    let document = match f.field("of", string_of)??.as_str() {
        "scene" => false,
        "document" => true,
        _ => return None,
    };
    let margin = f.field("margin", number_of)?;
    f.all_named().then_some(ViewBox::Bounds { document, margin })
}

fn view_box_of(value: &Value) -> Option<ViewBox> {
    match value {
        Value::Map(_) => bounds_of(value),
        _ => (string_of(value)? == "document").then_some(ViewBox::Document),
    }
}

/// `true` for the one value a flag-like field may hold, `name`.
fn named(value: &Value, name: &str) -> Option<bool> {
    (string_of(value)? == name).then_some(true)
}

pub(super) fn svg_of(value: &Value) -> Option<SvgAsk> {
    let mut f = Fields::of(value)?;
    let ask = SvgAsk {
        view_box: f.field("viewBox", view_box_of)?,
        width: f.field("width", number_of)?,
        height: f.field("height", number_of)?,
        padding: f.field("padding", number_of)?,
        background: f.field("background", string_of)?,
        text_fill: f.field("textFill", string_of)?,
        raster_scale: f.field("rasterScale", number_of)?,
        omit_legend: f.field("legend", |v| named(v, "omit"))?.unwrap_or(false),
        keyed: f.field("form", |v| named(v, "keyed"))?.unwrap_or(false),
    };
    f.all_named().then_some(ask)
}
