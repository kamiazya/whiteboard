//! The SVG a request asks to be answered with besides its scene (`svg`): the
//! envelope options a server render draws the laid-out scene with, read as
//! strictly as the rest of the request. Its `viewBox` names no box, since the
//! caller has no scene to measure before the layout: `'document'` is the
//! scene's document bounds, an empty box for a scene that draws nothing.

use whiteboard_model::Value;

use crate::json_canvas_wire::{Fields, number_of, string_of};

/// Where an asked SVG's `viewBox` comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ViewBox {
    /// The laid-out scene's document bounds (its legend's room included), or
    /// `0 0 0 0` for a scene with no node.
    Document,
}

/// What an answer's SVG is drawn with: `render_scene_to_svg`'s envelope
/// options, each absent unless the caller set it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SvgAsk {
    pub(crate) view_box: Option<ViewBox>,
    pub(crate) padding: Option<f64>,
    pub(crate) background: Option<String>,
    pub(crate) text_fill: Option<String>,
    pub(crate) raster_scale: Option<f64>,
}

fn view_box_of(value: &Value) -> Option<ViewBox> {
    (string_of(value)? == "document").then_some(ViewBox::Document)
}

pub(super) fn svg_of(value: &Value) -> Option<SvgAsk> {
    let mut f = Fields::of(value)?;
    let ask = SvgAsk {
        view_box: f.field("viewBox", view_box_of)?,
        padding: f.field("padding", number_of)?,
        background: f.field("background", string_of)?,
        text_fill: f.field("textFill", string_of)?,
        raster_scale: f.field("rasterScale", number_of)?,
    };
    f.all_named().then_some(ask)
}
