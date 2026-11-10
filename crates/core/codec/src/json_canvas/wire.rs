//! `jsonCanvasDocumentSchema` read the way Zod reads it, and lifted into the
//! model (`fromJsonCanvas`): the document, its nodes and its edges, with every
//! issue Zod raises for them, in its order.
//!
//! The `x-whiteboard` buckets are [`super::extension`]'s; they cost a bucket
//! and never raise an issue. What raises one is a node or an edge that is not
//! a node or an edge, and the three refinements on the document.

use super::extension::{self, EdgeExtension, NodeExtension};
use super::issue::{Code, Decline, Failure, Issue, PathStep};
use super::schema::{self, Flaws, Read, get, object};
use std::collections::BTreeSet;
use whiteboard_det::math::js_round;
use whiteboard_model::spatial::{
    Arrowhead, BackgroundStyle, CanvasEdge, EdgeEnd, EdgeSide, NodeResource, SpatialCanvas,
    SpatialNode,
};
use whiteboard_model::{Map, Value};

const TEXT_MIME: &str = "text/markdown";
const FILE_MIME: &str = "application/octet-stream";
const LINK_MIME: &str = "text/uri-list";

/// The issues raised so far, and where in the document the reader stands.
struct Cx {
    path: Vec<PathStep>,
    issues: Vec<Issue>,
    /// How many of the issues stop Zod from going on with the value they are about.
    aborts: usize,
    declined: Option<Decline>,
}

impl Cx {
    fn flaws(&mut self, flaws: Flaws) {
        for flaw in flaws {
            self.issues.push(Issue { path: self.path.clone(), code: flaw.code });
            if !flaw.continues {
                self.aborts = self.aborts.saturating_add(1);
            }
        }
    }

    fn take<T>(&mut self, (value, flaws): Read<T>) -> Option<T> {
        self.flaws(flaws);
        value
    }

    fn at<T>(&mut self, step: PathStep, read: impl FnOnce(&mut Self) -> T) -> T {
        self.path.push(step);
        let out = read(self);
        self.path.pop();
        out
    }

    fn refuse(&mut self, code: Code) {
        self.flaws(vec![schema::Flaw { code, continues: false }]);
    }

    /// A key the schema requires.
    fn required<'a, T>(
        &mut self,
        entries: &'a Map,
        key: &'static str,
        read: impl FnOnce(&'a Value) -> Read<T>,
    ) -> Option<T> {
        self.at(PathStep::Key(key), |cx| match get(entries, key) {
            None => {
                cx.refuse(Code::InvalidType);
                None
            }
            Some(value) => cx.take(read(value)),
        })
    }

    /// A key the schema allows to be absent.
    fn optional<'a, T>(
        &mut self,
        entries: &'a Map,
        key: &'static str,
        read: impl FnOnce(&'a Value) -> Read<T>,
    ) -> Option<T> {
        let value = get(entries, key)?;
        self.at(PathStep::Key(key), |cx| cx.take(read(value)))
    }

    /// A node or an edge that is not an object.
    fn entries<'a>(&mut self, value: &'a Value) -> Option<&'a Map> {
        let found = object(value);
        if found.is_none() {
            self.refuse(Code::InvalidType);
        }
        found
    }
}

fn pixel(value: f64) -> f64 {
    js_round(value) + 0.0
}

fn text(value: &Value) -> Read<String> {
    let (text, flaws) = schema::string(value);
    (text.map(str::to_string), flaws)
}

fn owned(read: Read<&str>) -> Read<String> {
    (read.0.map(str::to_string), read.1)
}

/// `nodes` or `edges`: a list read element by element, absent meaning empty.
fn list<T>(
    cx: &mut Cx,
    root: &Map,
    key: &'static str,
    read: impl Fn(&mut Cx, &Value) -> Option<T>,
) -> Option<Vec<T>> {
    let Some(found) = get(root, key) else { return Some(Vec::new()) };
    cx.at(PathStep::Key(key), |cx| {
        let Value::Seq(items) = found else {
            cx.refuse(Code::InvalidType);
            return None;
        };
        let read_all: Vec<Option<T>> = items
            .iter()
            .enumerate()
            .map(|(at, item)| cx.at(PathStep::Index(at), |cx| read(cx, item)))
            .collect();
        read_all.into_iter().collect()
    })
}

/// The members every node has, read in the schema's order.
struct Shared {
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    color: Option<whiteboard_model::spatial::CanvasColor>,
    extension: Option<NodeExtension>,
}

fn shared(cx: &mut Cx, entries: &Map) -> Option<Shared> {
    let id = cx.required(entries, "id", |v| owned(schema::node_id(v)));
    let x = cx.required(entries, "x", schema::int);
    let y = cx.required(entries, "y", schema::int);
    let width = cx.required(entries, "width", schema::size);
    let height = cx.required(entries, "height", schema::size);
    let color = cx.optional(entries, "color", schema::color);
    let extension = get(entries, "x-whiteboard").and_then(extension::node);
    Some(Shared { id: id?, x: x?, y: y?, width: width?, height: height?, color, extension })
}

fn node_from(shared: Shared, kind: Kind) -> SpatialNode {
    let Shared { id, x, y, width, height, color, extension } = shared;
    let (embed, facets, tags) =
        extension.map_or((None, None, None), |e| (e.embed, e.facets, e.tags));
    let mut node = SpatialNode {
        id,
        x: pixel(x),
        y: pixel(y),
        width: pixel(width),
        height: pixel(height),
        color,
        embed,
        facets,
        tags,
        ..SpatialNode::default()
    };
    match kind {
        Kind::Text(content) => {
            node.resource = Some(NodeResource {
                mime_type: TEXT_MIME.to_string(),
                content: Some(content),
                ..NodeResource::default()
            });
        }
        Kind::File(location, subpath) => {
            node.resource = Some(NodeResource {
                mime_type: FILE_MIME.to_string(),
                location: Some(location),
                subpath,
                ..NodeResource::default()
            });
        }
        Kind::Link(location) => {
            node.resource = Some(NodeResource {
                mime_type: LINK_MIME.to_string(),
                location: Some(location),
                ..NodeResource::default()
            });
        }
        Kind::Group(label, background, style) => {
            node.label = label;
            node.background = background;
            node.background_style = style;
        }
    }
    node
}

/// What the type-specific members of a node read as.
enum Kind {
    Text(String),
    File(String, Option<String>),
    Link(String),
    Group(Option<String>, Option<String>, Option<BackgroundStyle>),
}

fn kind(cx: &mut Cx, entries: &Map, wire_type: &str) -> Option<Kind> {
    match wire_type {
        "text" => cx.required(entries, "text", text).map(Kind::Text),
        "file" => {
            let file = cx.required(entries, "file", text);
            let subpath = cx.optional(entries, "subpath", |v| owned(schema::subpath(v)));
            Some(Kind::File(file?, subpath))
        }
        "link" => {
            let url = cx.at(PathStep::Key("url"), |cx| match get(entries, "url") {
                None => {
                    cx.refuse(Code::InvalidType);
                    None
                }
                Some(value) => match schema::link_url(value) {
                    Ok(read) => cx.take(read),
                    Err(why) => {
                        cx.declined = Some(why);
                        None
                    }
                },
            });
            url.map(Kind::Link)
        }
        _ => {
            let label = cx.optional(entries, "label", text);
            let background = cx.optional(entries, "background", text);
            let style = cx.optional(entries, "backgroundStyle", |v| {
                schema::variant(v, BackgroundStyle::from_wire)
            });
            Some(Kind::Group(label, background, style))
        }
    }
}

/// One element of `nodes`: a discriminated union on `type`.
fn node(cx: &mut Cx, value: &Value) -> Option<SpatialNode> {
    let entries = cx.entries(value)?;
    let wire_type = match get(entries, "type") {
        Some(Value::String(name))
            if matches!(name.as_str(), "text" | "file" | "link" | "group") =>
        {
            name.as_str()
        }
        _ => {
            cx.at(PathStep::Key("type"), |cx| cx.refuse(Code::InvalidUnion));
            return None;
        }
    };
    let mark = cx.aborts;
    let shared = shared(cx, entries);
    let kind = kind(cx, entries, wire_type);
    if cx.aborts > mark {
        return None;
    }
    Some(node_from(shared?, kind?))
}

/// One element of `edges`, its keys read in the schema's order.
fn edge(cx: &mut Cx, value: &Value) -> Option<CanvasEdge> {
    let entries = cx.entries(value)?;
    let mark = cx.aborts;
    let id = cx.required(entries, "id", |v| owned(schema::node_id(v)));
    let from_node = cx.required(entries, "fromNode", |v| owned(schema::node_id(v)));
    let to_node = cx.required(entries, "toNode", |v| owned(schema::node_id(v)));
    let side = |v: &Value| schema::variant(v, EdgeSide::from_wire);
    let arrow = |v: &Value| schema::variant(v, Arrowhead::from_wire);
    let from_side = cx.optional(entries, "fromSide", side);
    let to_side = cx.optional(entries, "toSide", side);
    let from_end = cx.optional(entries, "fromEnd", arrow);
    let to_end = cx.optional(entries, "toEnd", arrow);
    let color = cx.optional(entries, "color", schema::color);
    let label = cx.optional(entries, "label", text);
    let extension = get(entries, "x-whiteboard").and_then(extension::edge);
    if cx.aborts > mark {
        return None;
    }
    let extension = extension.unwrap_or(EdgeExtension { bends: None, facets: None, tags: None });
    Some(CanvasEdge {
        id: id?,
        from: EdgeEnd { node: from_node?, side: from_side, end: from_end },
        to: EdgeEnd { node: to_node?, side: to_side, end: to_end },
        color,
        label,
        bends: extension.bends,
        facets: extension.facets,
        tags: extension.tags,
    })
}

/// The first id that repeats an earlier one (`findDuplicateId`).
fn repeats<'a>(ids: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = BTreeSet::new();
    let mut ids = ids;
    ids.any(|id| !seen.insert(id))
}

/// The document's three refinements: node ids are unique, edge ids are unique,
/// and every edge runs between nodes that exist.
fn refine(cx: &mut Cx, nodes: &[SpatialNode], edges: &[CanvasEdge]) {
    let custom =
        |cx: &mut Cx, path: Vec<PathStep>| cx.issues.push(Issue { path, code: Code::Custom });
    if repeats(nodes.iter().map(|n| n.id.as_str())) {
        custom(cx, vec![PathStep::Key("nodes")]);
    }
    if repeats(edges.iter().map(|e| e.id.as_str())) {
        custom(cx, vec![PathStep::Key("edges")]);
    }
    let known: BTreeSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    for (at, edge) in edges.iter().enumerate() {
        for (key, node) in [("fromNode", &edge.from.node), ("toNode", &edge.to.node)] {
            if !known.contains(node.as_str()) {
                custom(cx, vec![PathStep::Key("edges"), PathStep::Index(at), PathStep::Key(key)]);
            }
        }
    }
}

/// Reads a parsed JSON Canvas document and lifts it into the model.
pub(super) fn document(value: &Value) -> Result<SpatialCanvas, Failure> {
    let mut cx = Cx { path: Vec::new(), issues: Vec::new(), aborts: 0, declined: None };
    let Some(root) = cx.entries(value) else { return Err(Failure::Schema(cx.issues)) };
    let nodes = list(&mut cx, root, "nodes", node);
    let edges = list(&mut cx, root, "edges", edge);
    if let (0, Some(nodes), Some(edges)) = (cx.aborts, nodes.as_deref(), edges.as_deref()) {
        refine(&mut cx, nodes, edges);
    }
    if let Some(why) = cx.declined {
        return Err(Failure::Declined(why));
    }
    if !cx.issues.is_empty() {
        return Err(Failure::Schema(cx.issues));
    }
    let extension = get(root, "x-whiteboard").and_then(extension::root);
    let (lines, facets, tags) =
        extension.map_or((None, None, None), |e| (e.lines, e.facets, e.tags));
    Ok(SpatialCanvas {
        nodes: nodes.unwrap_or_default(),
        edges: edges.unwrap_or_default(),
        lines,
        facets,
        tags,
    })
}
