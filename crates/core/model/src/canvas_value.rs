//! A spatial canvas as the value tree, and back: the lift a host's canvas
//! object takes into the model's [`SpatialCanvas`] and the value it is lowered
//! to again.
//!
//! The canvas's own objects are written in the order the TypeScript lifts them
//! in (`fromJsonCanvas`: the contract's field order but for an edge's `bends`,
//! which it puts last), an absent field left out, since a host sees the order
//! of an object's keys. They are read in any order, and strictly: a key the
//! contract does not name, a field of another kind or a missing required one
//! is no canvas, and the reader answers `None`.

use crate::spatial::{
    Arrowhead, BackgroundStyle, CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine,
    CanvasPoint, EdgeEnd, EdgeSide, LineEnd, LineEndNode, LineEndPoint, NodeEmbed, NodeResource,
    SpatialCanvas, SpatialNode,
};
use crate::{Map, Value};

// ---------------------------------------------------------------- the canvas as a value

type Members = Vec<(&'static str, Option<Value>)>;

fn object(fields: Members) -> Value {
    Value::Map(fields.into_iter().filter_map(|(k, v)| Some((k.to_string(), v?))).collect())
}

fn text(s: &str) -> Value {
    Value::String(s.to_string())
}

fn some_text(s: Option<&String>) -> Option<Value> {
    s.map(|s| text(s))
}

fn tags_value(tags: Option<&Vec<String>>) -> Option<Value> {
    tags.map(|t| Value::Seq(t.iter().map(|s| text(s)).collect()))
}

fn facets_value(facets: Option<&Map>) -> Option<Value> {
    facets.map(|f| Value::Map(f.clone()))
}

fn color_value(color: Option<&CanvasColor>) -> Option<Value> {
    color.map(|c| match c {
        CanvasColor::CanvasColorPreset(p) => text(p.as_str()),
        CanvasColor::CanvasColorHex(h) => text(h),
    })
}

fn point_value(p: &CanvasPoint) -> Value {
    object(vec![("x", Some(Value::Number(p.x))), ("y", Some(Value::Number(p.y)))])
}

fn bends_value(bends: Option<&Vec<CanvasPoint>>) -> Option<Value> {
    bends.map(|b| Value::Seq(b.iter().map(point_value).collect()))
}

fn side_value(side: Option<EdgeSide>) -> Option<Value> {
    side.map(|s| text(s.as_str()))
}

fn arrow_value(end: Option<Arrowhead>) -> Option<Value> {
    end.map(|e| text(e.as_str()))
}

fn node_value(n: &SpatialNode) -> Value {
    let embed = n.embed.as_ref().map(|e| {
        object(vec![
            ("documentId", Some(text(&e.document_id))),
            ("versionRef", some_text(e.version_ref.as_ref())),
        ])
    });
    let resource = n.resource.as_ref().map(|r| {
        object(vec![
            ("mimeType", Some(text(&r.mime_type))),
            ("content", some_text(r.content.as_ref())),
            ("location", some_text(r.location.as_ref())),
            ("subpath", some_text(r.subpath.as_ref())),
        ])
    });
    object(vec![
        ("id", Some(text(&n.id))),
        ("x", Some(Value::Number(n.x))),
        ("y", Some(Value::Number(n.y))),
        ("width", Some(Value::Number(n.width))),
        ("height", Some(Value::Number(n.height))),
        ("color", color_value(n.color.as_ref())),
        ("embed", embed),
        ("facets", facets_value(n.facets.as_ref())),
        ("tags", tags_value(n.tags.as_ref())),
        ("resource", resource),
        ("label", some_text(n.label.as_ref())),
        ("background", some_text(n.background.as_ref())),
        ("backgroundStyle", n.background_style.map(|s| text(s.as_str()))),
    ])
}

fn edge_end_value(e: &EdgeEnd) -> Value {
    object(vec![
        ("node", Some(text(&e.node))),
        ("side", side_value(e.side)),
        ("end", arrow_value(e.end)),
    ])
}

fn edge_value(e: &CanvasEdge) -> Value {
    object(vec![
        ("id", Some(text(&e.id))),
        ("from", Some(edge_end_value(&e.from))),
        ("to", Some(edge_end_value(&e.to))),
        ("color", color_value(e.color.as_ref())),
        ("label", some_text(e.label.as_ref())),
        ("facets", facets_value(e.facets.as_ref())),
        ("tags", tags_value(e.tags.as_ref())),
        ("bends", bends_value(e.bends.as_ref())),
    ])
}

fn line_end_value(e: &LineEnd) -> Value {
    match e {
        LineEnd::LineEndNode(n) => object(vec![
            ("kind", Some(text(LineEndNode::KIND))),
            ("node", Some(text(&n.node))),
            ("side", side_value(n.side)),
            ("end", arrow_value(n.end)),
        ]),
        LineEnd::LineEndPoint(p) => object(vec![
            ("kind", Some(text(LineEndPoint::KIND))),
            ("point", Some(point_value(&p.point))),
            ("end", arrow_value(p.end)),
        ]),
    }
}

fn line_value(l: &CanvasLine) -> Value {
    object(vec![
        ("id", Some(text(&l.id))),
        ("from", Some(line_end_value(&l.from))),
        ("to", Some(line_end_value(&l.to))),
        ("color", color_value(l.color.as_ref())),
        ("label", some_text(l.label.as_ref())),
        ("bends", bends_value(l.bends.as_ref())),
        ("facets", facets_value(l.facets.as_ref())),
    ])
}

/// The value of a canvas.
#[must_use]
pub fn canvas_value(c: &SpatialCanvas) -> Value {
    object(vec![
        ("nodes", Some(Value::Seq(c.nodes.iter().map(node_value).collect()))),
        ("edges", Some(Value::Seq(c.edges.iter().map(edge_value).collect()))),
        ("lines", c.lines.as_ref().map(|l| Value::Seq(l.iter().map(line_value).collect()))),
        ("facets", facets_value(c.facets.as_ref())),
        ("tags", tags_value(c.tags.as_ref())),
    ])
}

// ---------------------------------------------------------------- the value as a canvas

/// An object being read: the keys the contract names are taken, and what is
/// left over makes it no canvas object.
pub struct Fields<'a> {
    entries: &'a Map,
    taken: usize,
}

/// A field as read: `None` when it is malformed, `Some(None)` when absent.
pub type Read<T> = Option<Option<T>>;

impl<'a> Fields<'a> {
    /// The object `value` is, or `None` when it is no object.
    pub fn of(value: &'a Value) -> Option<Self> {
        match value {
            Value::Map(entries) => Some(Self { entries, taken: 0 }),
            _ => None,
        }
    }

    /// The field `name` read by `read`: `None` for one that is malformed,
    /// `Some(None)` for one that is absent.
    pub fn field<T>(&mut self, name: &str, read: impl FnOnce(&'a Value) -> Option<T>) -> Read<T> {
        let Some((_, value)) = self.entries.iter().find(|(key, _)| key == name) else {
            return Some(None);
        };
        self.taken = self.taken.saturating_add(1);
        read(value).map(Some)
    }

    /// Whether every key was one the contract names.
    pub fn all_named(&self) -> bool {
        self.taken == self.entries.len()
    }
}

/// The string `value` is.
pub fn string_of(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// The number `value` is.
pub fn number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => Some(*n),
        _ => None,
    }
}

/// Every item of the list `value` is, each read by `read`.
pub fn items_of<T>(value: &Value, read: impl Fn(&Value) -> Option<T>) -> Option<Vec<T>> {
    match value {
        Value::Seq(items) => items.iter().map(read).collect(),
        _ => None,
    }
}

/// The facet map `value` is, its entries as held.
pub fn facets_of(value: &Value) -> Option<Map> {
    match value {
        Value::Map(entries) => Some(entries.clone()),
        _ => None,
    }
}

fn tags_of(value: &Value) -> Option<Vec<String>> {
    items_of(value, string_of)
}

/// A colour: a preset's digit, or any other string as a hex colour.
pub fn color_of(value: &Value) -> Option<CanvasColor> {
    let color = string_of(value)?;
    Some(match CanvasColorPreset::from_wire(&color) {
        Some(preset) => CanvasColor::CanvasColorPreset(preset),
        None => CanvasColor::CanvasColorHex(color),
    })
}

fn side_of(value: &Value) -> Option<EdgeSide> {
    EdgeSide::from_wire(&string_of(value)?)
}

fn arrow_of(value: &Value) -> Option<Arrowhead> {
    Arrowhead::from_wire(&string_of(value)?)
}

fn point_of(value: &Value) -> Option<CanvasPoint> {
    let mut f = Fields::of(value)?;
    let (x, y) = (f.field("x", number_of)??, f.field("y", number_of)??);
    f.all_named().then_some(CanvasPoint { x, y })
}

/// A list of points.
pub fn bends_of(value: &Value) -> Option<Vec<CanvasPoint>> {
    items_of(value, point_of)
}

fn embed_of(value: &Value) -> Option<NodeEmbed> {
    let mut f = Fields::of(value)?;
    let document_id = f.field("documentId", string_of)??;
    let version_ref = f.field("versionRef", string_of)?;
    f.all_named().then_some(NodeEmbed { document_id, version_ref })
}

fn resource_of(value: &Value) -> Option<NodeResource> {
    let mut f = Fields::of(value)?;
    let mime_type = f.field("mimeType", string_of)??;
    let content = f.field("content", string_of)?;
    let location = f.field("location", string_of)?;
    let subpath = f.field("subpath", string_of)?;
    f.all_named().then_some(NodeResource { mime_type, content, location, subpath })
}

/// A node.
pub fn node_of(value: &Value) -> Option<SpatialNode> {
    let mut f = Fields::of(value)?;
    let node = SpatialNode {
        id: f.field("id", string_of)??,
        x: f.field("x", number_of)??,
        y: f.field("y", number_of)??,
        width: f.field("width", number_of)??,
        height: f.field("height", number_of)??,
        color: f.field("color", color_of)?,
        embed: f.field("embed", embed_of)?,
        facets: f.field("facets", facets_of)?,
        tags: f.field("tags", tags_of)?,
        resource: f.field("resource", resource_of)?,
        label: f.field("label", string_of)?,
        background: f.field("background", string_of)?,
        background_style: f
            .field("backgroundStyle", |v| BackgroundStyle::from_wire(&string_of(v)?))?,
    };
    f.all_named().then_some(node)
}

/// One end of an edge.
pub fn edge_end_of(value: &Value) -> Option<EdgeEnd> {
    let mut f = Fields::of(value)?;
    let end = EdgeEnd {
        node: f.field("node", string_of)??,
        side: f.field("side", side_of)?,
        end: f.field("end", arrow_of)?,
    };
    f.all_named().then_some(end)
}

/// An edge.
pub fn edge_of(value: &Value) -> Option<CanvasEdge> {
    let mut f = Fields::of(value)?;
    let edge = CanvasEdge {
        id: f.field("id", string_of)??,
        from: f.field("from", edge_end_of)??,
        to: f.field("to", edge_end_of)??,
        color: f.field("color", color_of)?,
        label: f.field("label", string_of)?,
        bends: f.field("bends", bends_of)?,
        facets: f.field("facets", facets_of)?,
        tags: f.field("tags", tags_of)?,
    };
    f.all_named().then_some(edge)
}

/// One end of a line: on a node, or at a point.
pub fn line_end_of(value: &Value) -> Option<LineEnd> {
    let mut f = Fields::of(value)?;
    let kind = f.field("kind", string_of)??;
    let end = f.field("end", arrow_of)?;
    let ready = if kind == LineEndNode::KIND {
        let (node, side) = (f.field("node", string_of)??, f.field("side", side_of)?);
        LineEnd::LineEndNode(LineEndNode { node, side, end })
    } else if kind == LineEndPoint::KIND {
        LineEnd::LineEndPoint(LineEndPoint { point: f.field("point", point_of)??, end })
    } else {
        return None;
    };
    // `kind` is read as a field, so a node end's `point` is an unnamed key here.
    f.all_named().then_some(ready)
}

/// A line.
pub fn line_of(value: &Value) -> Option<CanvasLine> {
    let mut f = Fields::of(value)?;
    let line = CanvasLine {
        id: f.field("id", string_of)??,
        from: f.field("from", line_end_of)??,
        to: f.field("to", line_end_of)??,
        color: f.field("color", color_of)?,
        label: f.field("label", string_of)?,
        bends: f.field("bends", bends_of)?,
        facets: f.field("facets", facets_of)?,
    };
    f.all_named().then_some(line)
}

/// The canvas `value` stands for, or `None` when it is no canvas.
pub fn canvas_of(value: &Value) -> Option<SpatialCanvas> {
    let mut f = Fields::of(value)?;
    let canvas = SpatialCanvas {
        nodes: f.field("nodes", |v| items_of(v, node_of))??,
        edges: f.field("edges", |v| items_of(v, edge_of))??,
        lines: f.field("lines", |v| items_of(v, line_of))?,
        facets: f.field("facets", facets_of)?,
        tags: f.field("tags", tags_of)?,
    };
    f.all_named().then_some(canvas)
}

#[cfg(test)]
mod tests;
