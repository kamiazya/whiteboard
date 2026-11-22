//! The model's schema for a stored node, edge or line, read over the loro
//! value a document holds it as.
//!
//! Each check answers whether the TypeScript's schema accepts the value:
//! `.strict()` objects refuse a key they do not name, an optional key refuses
//! `null`, and a facet bucket or a tag list that is malformed costs that field
//! and never the record (`.catch(undefined)`), so [`emit`] writes it as the
//! wire writes `undefined`. A record is the value a reader would hand back, so
//! a valid one is written as stored, keys ascending.

use crate::plain::{plain, undefined};
use loro::{LoroMapValue, LoroValue};
use whiteboard_codec::json_canvas::url_can_parse;
use whiteboard_model::Value;
use whiteboard_model::checks::{canonical_ulid, canvas_color_hex, extension_facet_keys};
use whiteboard_model::spatial::{Arrowhead, BackgroundStyle, CanvasColorPreset, EdgeSide};

const URI_LIST: &str = "text/uri-list";

pub(crate) fn is_readable_facet_key(key: &str) -> bool {
    extension_facet_keys(&vec![(key.to_owned(), Value::Null)]).is_empty()
}

fn text(value: &LoroValue) -> Option<&str> {
    match value {
        LoroValue::String(text) => Some(text.as_str()),
        _ => None,
    }
}

/// Whether the value is a number JavaScript can hold as a finite one.
fn finite(value: &LoroValue) -> bool {
    match value {
        LoroValue::Double(d) => d.is_finite(),
        LoroValue::I64(_) => true,
        _ => false,
    }
}

/// A node's width or height: finite and not negative.
fn size(value: &LoroValue) -> bool {
    match value {
        LoroValue::Double(d) => d.is_finite() && *d >= 0.0,
        LoroValue::I64(n) => *n >= 0,
        _ => false,
    }
}

fn node_id(value: &LoroValue) -> bool {
    text(value).is_some_and(|id| !id.is_empty())
}

/// The map's value under `key`, if the key is held.
fn field<'a>(map: &'a LoroMapValue, key: &str) -> Option<&'a LoroValue> {
    map.get(key)
}

/// Whether the key is absent or its value passes `check`; `null` is not absent.
fn optional(map: &LoroMapValue, key: &str, check: impl Fn(&LoroValue) -> bool) -> bool {
    field(map, key).is_none_or(check)
}

fn required(map: &LoroMapValue, key: &str, check: impl Fn(&LoroValue) -> bool) -> bool {
    field(map, key).is_some_and(check)
}

/// A strict object: every key held is one the schema names.
fn names_only(map: &LoroMapValue, keys: &[&str]) -> bool {
    map.iter().all(|(key, _)| keys.contains(&key.as_str()))
}

fn map_of(value: &LoroValue) -> Option<&LoroMapValue> {
    match value {
        LoroValue::Map(map) => Some(map),
        _ => None,
    }
}

fn color(value: &LoroValue) -> bool {
    text(value).is_some_and(|c| CanvasColorPreset::from_wire(c).is_some() || canvas_color_hex(c))
}

fn variant<T>(from_wire: fn(&str) -> Option<T>) -> impl Fn(&LoroValue) -> bool {
    move |value| text(value).and_then(from_wire).is_some()
}

fn is_text(value: &LoroValue) -> bool {
    text(value).is_some()
}

/// A facet bucket this build reads: an object whose every key is a facet key.
pub(crate) fn readable_facets(value: &LoroValue) -> bool {
    map_of(value).is_some_and(|facets| facets.iter().all(|(key, _)| is_readable_facet_key(key)))
}

fn tag_list(value: &LoroValue) -> bool {
    matches!(value, LoroValue::List(items) if items.iter().all(is_text))
}

fn point(value: &LoroValue) -> bool {
    map_of(value).is_some_and(|p| {
        names_only(p, &["x", "y"]) && required(p, "x", finite) && required(p, "y", finite)
    })
}

fn bends(value: &LoroValue) -> bool {
    matches!(value, LoroValue::List(points) if (1..=64).contains(&points.len()) && points.iter().all(point))
}

fn embed(value: &LoroValue) -> bool {
    map_of(value).is_some_and(|e| {
        names_only(e, &["documentId", "versionRef"])
            && required(e, "documentId", |v| text(v).is_some_and(canonical_ulid))
            && optional(e, "versionRef", |v| text(v).is_some_and(|r| !r.is_empty()))
    })
}

fn resource(value: &LoroValue) -> bool {
    let Some(r) = map_of(value) else { return false };
    let located = field(r, "location").and_then(text);
    names_only(r, &["mimeType", "content", "location", "subpath"])
        && required(r, "mimeType", |v| text(v).is_some_and(|m| !m.is_empty()))
        && optional(r, "content", is_text)
        && optional(r, "location", is_text)
        && optional(r, "subpath", |v| text(v).is_some_and(|s| s.starts_with('#')))
        && (field(r, "mimeType").and_then(text) != Some(URI_LIST)
            || located.is_none_or(url_can_parse))
        && (field(r, "content").is_none() || field(r, "location").is_none())
}

/// An end that names a node, the edge's whole end and the line's node arm
/// beside its `kind`.
fn node_end(end: &LoroMapValue, extra: &[&str]) -> bool {
    let mut keys = vec!["node", "side", "end"];
    keys.extend_from_slice(extra);
    names_only(end, &keys)
        && required(end, "node", node_id)
        && optional(end, "side", variant(EdgeSide::from_wire))
        && optional(end, "end", variant(Arrowhead::from_wire))
}

fn edge_end(value: &LoroValue) -> bool {
    map_of(value).is_some_and(|end| node_end(end, &[]))
}

fn line_end(value: &LoroValue) -> bool {
    let Some(end) = map_of(value) else { return false };
    match field(end, "kind").and_then(text) {
        Some("node") => node_end(end, &["kind"]),
        Some("point") => {
            names_only(end, &["kind", "point", "end"])
                && required(end, "point", point)
                && optional(end, "end", variant(Arrowhead::from_wire))
        }
        _ => false,
    }
}

/// Whether `spatialNodeSchema` accepts the value.
pub(crate) fn node(value: &LoroValue) -> bool {
    let Some(n) = map_of(value) else { return false };
    let framed = ["label", "background", "backgroundStyle"].iter().any(|k| field(n, k).is_some());
    names_only(
        n,
        &[
            "id",
            "x",
            "y",
            "width",
            "height",
            "color",
            "embed",
            "facets",
            "tags",
            "resource",
            "label",
            "background",
            "backgroundStyle",
        ],
    ) && required(n, "id", node_id)
        && required(n, "x", finite)
        && required(n, "y", finite)
        && required(n, "width", size)
        && required(n, "height", size)
        && optional(n, "color", color)
        && optional(n, "embed", embed)
        && optional(n, "resource", resource)
        && optional(n, "label", is_text)
        && optional(n, "background", is_text)
        && optional(n, "backgroundStyle", variant(BackgroundStyle::from_wire))
        && !(field(n, "resource").is_some() && framed)
}

/// Whether `canvasEdgeSchema` accepts the value.
pub(crate) fn edge(value: &LoroValue) -> bool {
    let Some(e) = map_of(value) else { return false };
    names_only(e, &["id", "from", "to", "color", "label", "bends", "facets", "tags"])
        && required(e, "id", node_id)
        && required(e, "from", edge_end)
        && required(e, "to", edge_end)
        && optional(e, "color", color)
        && optional(e, "label", is_text)
        && optional(e, "bends", bends)
}

/// Whether `canvasLineSchema` accepts the value: an edge's fields with an end
/// that may be a point, and no tags.
pub(crate) fn line(value: &LoroValue) -> bool {
    let Some(l) = map_of(value) else { return false };
    names_only(l, &["id", "from", "to", "color", "label", "bends", "facets"])
        && required(l, "id", node_id)
        && required(l, "from", line_end)
        && required(l, "to", line_end)
        && optional(l, "color", color)
        && optional(l, "label", is_text)
        && optional(l, "bends", bends)
}

/// A record the schema accepted, as the reader hands it back. `None` for a
/// value the wire cannot write (loro bytes in a facet payload).
pub(crate) fn emit(record: &LoroValue) -> Option<Value> {
    let map = map_of(record)?;
    let mut written = Vec::new();
    for (key, held) in map.iter() {
        let kept = match key.as_str() {
            "facets" if !readable_facets(held) => undefined(),
            "tags" if !tag_list(held) => undefined(),
            _ => plain(held)?,
        };
        written.push((key.clone(), kept));
    }
    written.sort_by(|a, b| a.0.cmp(&b.0));
    Some(Value::Map(written))
}

/// A tag list the board reads, or `None` for a malformed one.
pub(crate) fn readable_tags(value: &LoroValue) -> Option<&LoroValue> {
    tag_list(value).then_some(value)
}
