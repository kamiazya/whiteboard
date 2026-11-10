//! `toJsonCanvas`: a document as the JSON Canvas value that is written.
//!
//! Built field by field, in the order the TypeScript projection builds its
//! object literals, so the keys come out in the same order. Geometry crosses
//! as the nearest whole pixel, ink as the number JSON can carry back, and the
//! extension key is left out entirely in the strict mode.

use super::issue::Mode;
use whiteboard_det::math::js_round;
use whiteboard_model::spatial::{
    CanvasColor, CanvasEdge, CanvasLine, CanvasPoint, EdgeEnd, ExtensionFacets, LineEnd,
    NodeResource, SpatialCanvas, SpatialNode,
};
use whiteboard_model::{Map, Value};

const LINK_MIME: &str = "text/uri-list";

/// An object being built, key by key, leaving out what is absent.
struct Obj(Map);

impl Obj {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn put(mut self, key: &str, value: Value) -> Self {
        self.0.push((key.to_string(), value));
        self
    }

    fn maybe(self, key: &str, value: Option<Value>) -> Self {
        match value {
            Some(value) => self.put(key, value),
            None => self,
        }
    }

    fn done(self) -> Value {
        Value::Map(self.0)
    }
}

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

fn number(value: f64) -> Value {
    Value::Number(value)
}

/// `Math.round(value) + 0`: JSON has no negative zero.
fn pixel(value: f64) -> f64 {
    js_round(value) + 0.0
}

/// A coordinate JSON text can carry back, which is every number but `-0`.
fn json_zero(value: f64) -> f64 {
    value + 0.0
}

fn color(color: Option<&CanvasColor>) -> Option<Value> {
    color.map(|color| match color {
        CanvasColor::CanvasColorPreset(preset) => text(preset.as_str()),
        CanvasColor::CanvasColorHex(hex) => text(hex),
    })
}

fn label(value: Option<&String>) -> Option<Value> {
    value.map(|value| text(value))
}

fn facets(value: Option<&ExtensionFacets>) -> Option<Value> {
    value.map(|map| Value::Map(map.clone()))
}

fn tags(value: Option<&Vec<String>>) -> Option<Value> {
    value.map(|tags| Value::Seq(tags.iter().map(|tag| text(tag)).collect()))
}

fn point(point: &CanvasPoint, convert: fn(f64) -> f64) -> Value {
    Obj::new().put("x", number(convert(point.x))).put("y", number(convert(point.y))).done()
}

fn points(value: Option<&Vec<CanvasPoint>>, convert: fn(f64) -> f64) -> Option<Value> {
    value.map(|list| Value::Seq(list.iter().map(|p| point(p, convert)).collect()))
}

/// What a node shows, as the format's node kinds see it.
enum Shown<'a> {
    Text(&'a str),
    File(&'a str, Option<&'a str>),
    Link(&'a str),
    Nothing,
}

fn shown(node: &SpatialNode) -> Shown<'_> {
    let Some(NodeResource { mime_type, content, location, subpath }) = &node.resource else {
        return Shown::Nothing;
    };
    match (content, location) {
        (Some(content), _) => Shown::Text(content),
        (None, Some(location)) if mime_type == LINK_MIME => Shown::Link(location),
        (None, Some(location)) => Shown::File(location, subpath.as_deref()),
        (None, None) => Shown::Nothing,
    }
}

/// A node's extension, or nothing when it has neither an embed nor facets nor tags.
fn node_extension(node: &SpatialNode) -> Option<Value> {
    if let Some(embed) = &node.embed {
        return Some(
            Obj::new()
                .put("kind", text("embed"))
                .put("documentId", text(&embed.document_id))
                .maybe("versionRef", label(embed.version_ref.as_ref()))
                .maybe("facets", facets(node.facets.as_ref()))
                .maybe("tags", tags(node.tags.as_ref()))
                .done(),
        );
    }
    if node.facets.is_none() && node.tags.is_none() {
        return None;
    }
    Some(
        Obj::new()
            .maybe("facets", facets(node.facets.as_ref()))
            .maybe("tags", tags(node.tags.as_ref()))
            .done(),
    )
}

fn node(node: &SpatialNode, mode: Mode) -> Value {
    let extension = if mode == Mode::Extended { node_extension(node) } else { None };
    let base = Obj::new()
        .put("id", text(&node.id))
        .put("x", number(pixel(node.x)))
        .put("y", number(pixel(node.y)))
        .put("width", number(pixel(node.width)))
        .put("height", number(pixel(node.height)))
        .maybe("color", color(node.color.as_ref()))
        .maybe("x-whiteboard", extension);
    match shown(node) {
        Shown::Text(content) => base.put("type", text("text")).put("text", text(content)),
        Shown::File(file, subpath) => base
            .put("type", text("file"))
            .put("file", text(file))
            .maybe("subpath", subpath.map(text)),
        Shown::Link(url) => base.put("type", text("link")).put("url", text(url)),
        Shown::Nothing => base
            .put("type", text("group"))
            .maybe("label", label(node.label.as_ref()))
            .maybe("background", label(node.background.as_ref()))
            .maybe("backgroundStyle", node.background_style.map(|style| text(style.as_str()))),
    }
    .done()
}

fn edge_extension(edge: &CanvasEdge) -> Option<Value> {
    let bends = points(edge.bends.as_ref(), pixel);
    if edge.facets.is_none() && edge.tags.is_none() && bends.is_none() {
        return None;
    }
    Some(
        Obj::new()
            .maybe("facets", facets(edge.facets.as_ref()))
            .maybe("tags", tags(edge.tags.as_ref()))
            .maybe("bends", bends)
            .done(),
    )
}

fn end_parts(end: &EdgeEnd) -> (Option<Value>, Option<Value>) {
    (end.side.map(|side| text(side.as_str())), end.end.map(|head| text(head.as_str())))
}

fn edge(edge: &CanvasEdge, mode: Mode) -> Value {
    let extension = if mode == Mode::Extended { edge_extension(edge) } else { None };
    let (from_side, from_end) = end_parts(&edge.from);
    let (to_side, to_end) = end_parts(&edge.to);
    Obj::new()
        .put("id", text(&edge.id))
        .put("fromNode", text(&edge.from.node))
        .put("toNode", text(&edge.to.node))
        .maybe("fromSide", from_side)
        .maybe("toSide", to_side)
        .maybe("fromEnd", from_end)
        .maybe("toEnd", to_end)
        .maybe("color", color(edge.color.as_ref()))
        .maybe("label", label(edge.label.as_ref()))
        .maybe("x-whiteboard", extension)
        .done()
}

fn line_end(end: &LineEnd) -> Value {
    match end {
        LineEnd::LineEndNode(on_node) => Obj::new()
            .put("kind", text("node"))
            .put("node", text(&on_node.node))
            .maybe("side", on_node.side.map(|side| text(side.as_str())))
            .maybe("end", on_node.end.map(|head| text(head.as_str())))
            .done(),
        LineEnd::LineEndPoint(free) => Obj::new()
            .put("kind", text("point"))
            .put("point", point(&free.point, json_zero))
            .maybe("end", free.end.map(|head| text(head.as_str())))
            .done(),
    }
}

fn line(line: &CanvasLine) -> Value {
    Obj::new()
        .put("id", text(&line.id))
        .put("from", line_end(&line.from))
        .put("to", line_end(&line.to))
        .maybe("color", color(line.color.as_ref()))
        .maybe("label", label(line.label.as_ref()))
        .maybe("bends", points(line.bends.as_ref(), json_zero))
        .maybe("facets", facets(line.facets.as_ref()))
        .done()
}

/// The document as a JSON Canvas value: `{nodes, edges}`, and `x-whiteboard`
/// after them when the extension holds anything.
pub(super) fn document(canvas: &SpatialCanvas, mode: Mode) -> Value {
    let wire = Obj::new()
        .put("nodes", Value::Seq(canvas.nodes.iter().map(|n| node(n, mode)).collect()))
        .put("edges", Value::Seq(canvas.edges.iter().map(|e| edge(e, mode)).collect()));
    if mode == Mode::Strict {
        return wire.done();
    }
    let lines = canvas.lines.as_ref().map(|lines| Value::Seq(lines.iter().map(line).collect()));
    let extension = Obj::new()
        .maybe("lines", lines)
        .maybe("facets", facets(canvas.facets.as_ref()))
        .maybe("tags", tags(canvas.tags.as_ref()));
    if extension.0.is_empty() {
        return wire.done();
    }
    wire.put("x-whiteboard", extension.done()).done()
}
