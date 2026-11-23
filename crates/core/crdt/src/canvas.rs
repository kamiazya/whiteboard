//! A spatial document's canvas as the reader hands it back: the stored nodes,
//! edges and lines its schema accepts, how many records it refused, the
//! canvas-level facets and tags, and the one half of a document's content its
//! kind names.
//!
//! A record in a retired shape refuses the whole read rather than being
//! skipped, since skipping it would open the canvas without an element the
//! document still holds.

use crate::content::{
    DocumentKind, Refusal, document_kind, map_of, retired_canvas_shape,
    retired_markdown_canvas_shape, value_of,
};
use crate::envelope::{Core, core_facets};
use crate::plain::plain;
use crate::stored;
use loro::{LoroDoc, LoroValue};
use whiteboard_model::Value;

const NODES_KEY: &str = "nodes";
const EDGES_KEY: &str = "edges";
const LINES_KEY: &str = "lines";
const CANVAS_KEY: &str = "canvas";
const CANVAS_FACETS_FIELD: &str = "facets";
const CANVAS_TAGS_FIELD: &str = "tags";
const RETIRED_SHAPE_REFUSAL: &str = "RetiredStoredShapeError";

/// What `readSpatialCanvasWithSkipped` found, before it is written as a value.
pub(crate) struct Canvas {
    nodes: Vec<LoroValue>,
    edges: Vec<LoroValue>,
    lines: Vec<LoroValue>,
    facets: Option<Vec<(String, LoroValue)>>,
    tags: Option<LoroValue>,
    skipped: usize,
}

/// The records of `key` the schema accepts, in the map's key order, and the
/// count of those it refused.
fn accepted(doc: &LoroDoc, key: &str, check: fn(&LoroValue) -> bool) -> (Vec<LoroValue>, usize) {
    let map = map_of(doc, key);
    let mut kept = Vec::new();
    let mut refused = 0_usize;
    for id in map.keys() {
        match map.get(&id).and_then(value_of) {
            Some(record) if check(&record) => kept.push(record),
            _ => refused = refused.saturating_add(1),
        }
    }
    (kept, refused)
}

/// The canvas facets this build reads, and how many stored entries it cannot.
/// A bucket with entries and none readable answers none, as one never stored.
fn canvas_facets(doc: &LoroDoc) -> (Option<Vec<(String, LoroValue)>>, usize) {
    let held = map_of(doc, CANVAS_KEY).get(CANVAS_FACETS_FIELD).and_then(value_of);
    let Some(LoroValue::Map(stored)) = held else { return (None, 0) };
    let (readable, unreadable): (Vec<_>, Vec<_>) =
        stored.iter().partition(|(key, _)| stored::is_readable_facet_key(key));
    let facets: Vec<(String, LoroValue)> =
        readable.into_iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let none_readable = facets.is_empty() && !stored.is_empty();
    (if none_readable { None } else { Some(facets) }, unreadable.len())
}

/// Reads the canvas, refusing a retired shape.
pub(crate) fn read_canvas(doc: &LoroDoc) -> Result<Canvas, Refusal> {
    if retired_canvas_shape(doc).is_some() {
        return Err(Refusal(RETIRED_SHAPE_REFUSAL));
    }
    let (nodes, refused_nodes) = accepted(doc, NODES_KEY, stored::node);
    let (edges, refused_edges) = accepted(doc, EDGES_KEY, stored::edge);
    let (lines, refused_lines) = accepted(doc, LINES_KEY, stored::line);
    let (facets, unreadable) = canvas_facets(doc);
    let tags = map_of(doc, CANVAS_KEY)
        .get(CANVAS_TAGS_FIELD)
        .and_then(value_of)
        .filter(|held| stored::readable_tags(held).is_some());
    let skipped = [refused_nodes, refused_edges, refused_lines, unreadable]
        .iter()
        .fold(0_usize, |sum, n| sum.saturating_add(*n));
    Ok(Canvas { nodes, edges, lines, facets, tags, skipped })
}

impl Canvas {
    /// The nodes the schema accepted.
    pub(crate) fn nodes(&self) -> &[LoroValue] {
        &self.nodes
    }
}

fn records(held: &[LoroValue]) -> Option<Value> {
    Some(Value::Seq(held.iter().map(stored::emit).collect::<Option<Vec<_>>>()?))
}

impl Canvas {
    /// The canvas as a value: `lines`, `facets` and `tags` only when held.
    /// `None` for a payload the wire cannot write.
    fn value(&self) -> Option<Value> {
        let mut entries = vec![
            ("nodes".to_owned(), records(&self.nodes)?),
            ("edges".to_owned(), records(&self.edges)?),
        ];
        if !self.lines.is_empty() {
            entries.push(("lines".to_owned(), records(&self.lines)?));
        }
        if let Some(facets) = &self.facets {
            let mut shown = Vec::new();
            for (key, held) in facets {
                shown.push((key.clone(), plain(held)?));
            }
            shown.sort_by(|a, b| a.0.cmp(&b.0));
            entries.push(("facets".to_owned(), Value::Map(shown)));
        }
        if let Some(tags) = &self.tags {
            entries.push(("tags".to_owned(), plain(tags)?));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        Some(Value::Map(entries))
    }
}

/// `spatialCanvas`: the canvas and how many records were refused.
pub(crate) fn spatial_canvas(doc: &LoroDoc) -> Result<Option<Value>, Refusal> {
    let canvas = read_canvas(doc)?;
    let skipped = f64::from(u32::try_from(canvas.skipped).unwrap_or(u32::MAX));
    Ok(canvas.value().map(|value| {
        Value::Map(vec![
            ("canvas".to_owned(), value),
            ("skipped".to_owned(), Value::Number(skipped)),
        ])
    }))
}

/// `spatialNodeCount`: advisory, so a canvas that cannot be read counts none.
pub(crate) fn spatial_node_count(doc: &LoroDoc) -> Value {
    let held = read_canvas(doc).map_or(0, |canvas| canvas.nodes.len());
    Value::Number(f64::from(u32::try_from(held).unwrap_or(u32::MAX)))
}

/// The kind a content read goes by: the document's own, else the one asked for.
pub(crate) fn kind_asked(doc: &LoroDoc, fallback: Option<DocumentKind>) -> DocumentKind {
    document_kind(doc).or(fallback).unwrap_or(DocumentKind::Spatial)
}

/// `documentContent`'s value, and the tags a markdown document carries beside it.
pub(crate) struct Content {
    pub value: Value,
    pub tags: Option<Value>,
}

/// A document's content by kind: the canvas of a spatial one, the body and
/// summary of a markdown one.
pub(crate) fn document_content(
    doc: &LoroDoc,
    fallback: Option<DocumentKind>,
) -> Result<Option<Content>, Refusal> {
    if kind_asked(doc, fallback) != DocumentKind::Markdown {
        let canvas = read_canvas(doc)?;
        let canvas = canvas.value().map(|value| {
            Value::Map(vec![
                ("canvas".to_owned(), value),
                ("kind".to_owned(), Value::String("spatial".to_owned())),
            ])
        });
        return Ok(canvas.map(|value| Content { value, tags: None }));
    }
    let core = core_facets(doc);
    if retired_markdown_canvas_shape(doc).is_some() {
        return Err(Refusal(RETIRED_SHAPE_REFUSAL));
    }
    let body = crate::content::markdown_body(doc)?;
    let mut entries = vec![
        ("body".to_owned(), Value::String(body)),
        ("kind".to_owned(), Value::String("markdown".to_owned())),
    ];
    if let Some(description) = core.as_ref().and_then(Core::description) {
        entries.insert(1, ("description".to_owned(), Value::String(description.to_owned())));
    }
    let mut tags = None;
    if let Some(held) = core.as_ref().and_then(Core::tags) {
        let Some(written) = plain(held) else { return Ok(None) };
        tags = Some(written);
    }
    Ok(Some(Content { value: Value::Map(entries), tags }))
}

/// `documentContentWithTags`: the content and, for a markdown document that
/// has them, its tags.
pub(crate) fn content_with_tags(content: Content) -> Value {
    let mut entries = vec![("content".to_owned(), content.value)];
    if let Some(tags) = content.tags {
        entries.push(("tags".to_owned(), tags));
    }
    Value::Map(entries)
}
