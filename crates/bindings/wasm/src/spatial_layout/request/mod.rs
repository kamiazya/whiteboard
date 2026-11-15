//! What `layout_spatial_canvas` is asked, read from the value wire of
//! [`crate::json_canvas_wire`]: one mapping whose fields are the layout's
//! options as data. Read strictly, as the canvas is: a key the request does
//! not name, a field of another kind or a missing required one is no request.

mod code;
mod measure;
mod options;
mod references;

use whiteboard_canvas_render::references::{Expansion, FenceTokens, ReferenceWire};
use whiteboard_canvas_render::theme::geometry::SpatialGeometry;
use whiteboard_edge_routing::edge_sides::EdgeAnchorOverride;
use whiteboard_model::Value;
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_plugin_visual::visual::TagLibrary;

use crate::json_canvas_wire::{Fields, canvas_of, items_of, string_of};
use code::code_tokens_of;
pub(crate) use measure::MeasureSpec;
use measure::measure_of;
pub(crate) use options::Style;
use options::{dark_of, expansion_of, geometry_of, override_of, style_of, tag_key_of};
use references::references_of;

/// A layout request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Request {
    pub(crate) canvas: SpatialCanvas,
    pub(crate) measure: MeasureSpec,
    pub(crate) dark: bool,
    pub(crate) style: Style,
    /// The families a theme may name that this surface holds a face for.
    pub(crate) font_families: Vec<String>,
    pub(crate) geometry: Option<SpatialGeometry>,
    pub(crate) locked: Vec<String>,
    pub(crate) suppressed: Vec<String>,
    pub(crate) overrides: Option<Vec<(String, EdgeAnchorOverride)>>,
    pub(crate) tags: Option<TagLibrary>,
    pub(crate) embed_path: Vec<String>,
    pub(crate) references: ReferenceWire,
    pub(crate) expand: Expansion,
    pub(crate) code_tokens: Vec<FenceTokens>,
}

fn flag_of(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

fn strings_of(value: &Value) -> Option<Vec<String>> {
    items_of(value, string_of)
}

/// The entries of a mapping, each read by `read`.
fn entries_of<T>(value: &Value, read: impl Fn(&Value) -> Option<T>) -> Option<Vec<(String, T)>> {
    match value {
        Value::Map(entries) => {
            entries.iter().map(|(key, item)| Some((key.clone(), read(item)?))).collect()
        }
        _ => None,
    }
}

/// A two-item list, each item read by its own reader.
fn pair_of<A, B>(
    value: &Value,
    first: impl Fn(&Value) -> Option<A>,
    second: impl Fn(&Value) -> Option<B>,
) -> Option<(A, B)> {
    match value {
        Value::Seq(items) => match items.as_slice() {
            [a, b] => Some((first(a)?, second(b)?)),
            _ => None,
        },
        _ => None,
    }
}

fn table_of<T>(value: &Value, read: impl Fn(&Value) -> Option<T>) -> Option<Vec<(String, T)>> {
    items_of(value, |row| pair_of(row, string_of, &read))
}

/// The request a value stands for, or `None` when it is none.
pub(crate) fn request_of(value: &Value) -> Option<Request> {
    let mut f = Fields::of(value)?;
    let request = Request {
        canvas: f.field("canvas", canvas_of)??,
        measure: f.field("measure", measure_of)??,
        dark: f.field("mode", dark_of)??,
        style: f.field("style", style_of)?.unwrap_or_default(),
        font_families: f
            .field("fontFamilies", strings_of)?
            .unwrap_or_default()
            .into_iter()
            .collect(),
        geometry: f.field("geometry", geometry_of)?,
        locked: f.field("lockedNodeIds", strings_of)?.unwrap_or_default(),
        suppressed: f.field("suppressedBodyNodeIds", strings_of)?.unwrap_or_default(),
        overrides: f.field("sideOverrides", |v| table_of(v, override_of))?,
        tags: f.field("tagLibrary", |v| entries_of(v, tag_key_of))?,
        embed_path: f.field("embedPath", strings_of)?.unwrap_or_default(),
        references: f.field("references", references_of)?.unwrap_or_default(),
        expand: f.field("expand", expansion_of)??,
        code_tokens: f.field("codeTokens", code_tokens_of)?.unwrap_or_default(),
    };
    f.all_named().then_some(request)
}
