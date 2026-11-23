//! What a proposed change's `patch` and `assumed` may hold: the fields of a
//! node, an edge or a line a change may set, each optional and all strict
//! (`nodePatchFieldsSchema`, `edgePatchFieldsSchema`, `linePatchFieldsSchema`).
//!
//! A patch is the stored shape with its identity left out, so each field is
//! held to what the stored element holds it to; the link a node patch names is
//! `z.url()`, which trims the text and deletes tabs and line breaks from what
//! it hands back.

use crate::plain::{object_of, plain, undefined};
use crate::stored::{
    bends, color, edge_end, finite, is_text, line_end, map_of, readable_facets, size, text, variant,
};
use loro::LoroValue;
use whiteboard_codec::json_canvas::url_can_parse;
use whiteboard_model::Value;
use whiteboard_model::checks::is_js_space;
use whiteboard_model::spatial::BackgroundStyle;

/// What `z.url()` answers for the text: it trims, then asks `URL.canParse`,
/// and hands back the trimmed text without tabs and line breaks.
fn url_value(text: &str) -> Option<String> {
    let trimmed = text.trim_matches(is_js_space);
    url_can_parse(trimmed)
        .then(|| trimmed.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect())
}

fn node_field(key: &str, value: &LoroValue) -> bool {
    match key {
        "x" | "y" => finite(value),
        "width" | "height" => size(value),
        "color" => color(value),
        "text" | "file" | "label" | "background" => is_text(value),
        "subpath" => text(value).is_some_and(|s| s.starts_with('#')),
        "url" => text(value).and_then(url_value).is_some(),
        "backgroundStyle" => variant(BackgroundStyle::from_wire)(value),
        _ => false,
    }
}

/// The fields an edge and a line share; `end` judges the end of its own kind.
fn element_field(key: &str, value: &LoroValue, end: fn(&LoroValue) -> bool) -> bool {
    match key {
        "from" | "to" => end(value),
        "color" => color(value),
        "label" => is_text(value),
        "bends" => bends(value),
        // A bucket this build cannot read costs the field, never the patch.
        "facets" => true,
        _ => false,
    }
}

fn edge_field(key: &str, value: &LoroValue) -> bool {
    element_field(key, value, edge_end)
}

fn line_field(key: &str, value: &LoroValue) -> bool {
    element_field(key, value, line_end)
}

fn every_field(value: &LoroValue, field: fn(&str, &LoroValue) -> bool) -> bool {
    map_of(value).is_some_and(|fields| fields.iter().all(|(key, held)| field(key, held)))
}

/// Whether `nodePatchFieldsSchema` accepts the value.
pub(crate) fn node_patch(value: &LoroValue) -> bool {
    every_field(value, node_field)
}

/// Whether `edgePatchFieldsSchema` accepts the value.
pub(crate) fn edge_patch(value: &LoroValue) -> bool {
    every_field(value, edge_field)
}

/// Whether `linePatchFieldsSchema` accepts the value.
pub(crate) fn line_patch(value: &LoroValue) -> bool {
    every_field(value, line_field)
}

/// A patch the schema accepted, as the reader hands it back: a facet bucket
/// this build cannot read is written as no value and a link as `z.url()`
/// returns it. `None` for a value the wire cannot write.
pub(crate) fn emit_patch(value: &LoroValue) -> Option<Value> {
    let mut written = Vec::new();
    for (key, held) in map_of(value)?.iter() {
        let shown = match key.as_str() {
            "facets" if !readable_facets(held) => undefined(),
            "url" => Value::String(text(held).and_then(url_value)?),
            _ => plain(held)?,
        };
        written.push((key.clone(), shown));
    }
    Some(object_of(written))
}
