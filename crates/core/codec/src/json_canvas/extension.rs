//! The `x-whiteboard` extension at its three sites, and the ink it carries.
//!
//! Every reader here answers `Some` or `None` and nothing else: each site is
//! `.optional().catch(undefined)`, so a value that fails costs its bucket and
//! never the document, and the issues Zod raised on the way are discarded.

use super::schema::{self, get, object, silent};
use whiteboard_model::checks::{canonical_ulid, extension_facet_keys};
use whiteboard_model::spatial::{
    Arrowhead, CanvasLine, CanvasPoint, EdgeSide, ExtensionFacets, LineEnd, LineEndNode,
    LineEndPoint, NodeEmbed,
};
use whiteboard_model::{Map, Value};

/// The largest list of bends, the contract's `Bends.maxItems`.
const MAX_BENDS: usize = 64;

/// What a node's `x-whiteboard` holds.
pub(super) struct NodeExtension {
    pub embed: Option<NodeEmbed>,
    pub facets: Option<ExtensionFacets>,
    pub tags: Option<Vec<String>>,
}

/// What an edge's `x-whiteboard` holds.
pub(super) struct EdgeExtension {
    pub bends: Option<Vec<CanvasPoint>>,
    pub facets: Option<ExtensionFacets>,
    pub tags: Option<Vec<String>>,
}

/// What the document's `x-whiteboard` holds.
pub(super) struct RootExtension {
    pub lines: Option<Vec<CanvasLine>>,
    pub facets: Option<ExtensionFacets>,
    pub tags: Option<Vec<String>>,
}

/// A key's value through `read`, or `Err` when the key is there and read fails:
/// the shape of an optional key in an object that is not itself caught.
fn optional<T>(
    entries: &Map,
    key: &str,
    read: impl Fn(&Value) -> Option<T>,
) -> Result<Option<T>, ()> {
    match get(entries, key) {
        None => Ok(None),
        Some(value) => read(value).map(Some).ok_or(()),
    }
}

/// A key's value through `read`, or `None` for an absent key and for a value
/// that fails: `.optional().catch(undefined)`.
fn caught<T>(entries: &Map, key: &str, read: impl Fn(&Value) -> Option<T>) -> Option<T> {
    get(entries, key).and_then(read)
}

/// A strict object: no key outside `allowed`.
fn strict<'a>(value: &'a Value, allowed: &[&str]) -> Option<&'a Map> {
    let entries = object(value)?;
    entries.iter().all(|(key, _)| allowed.contains(&key.as_str())).then_some(entries)
}

/// `extensionFacetsSchema`: a plain object whose keys are all facet keys. Zod
/// skips a key named `__proto__` while it copies a record, so it never reaches
/// the check on keys and is not kept.
pub(super) fn facets(value: &Value) -> Option<ExtensionFacets> {
    let entries: Map =
        object(value)?.iter().filter(|(key, _)| key != "__proto__").cloned().collect();
    extension_facet_keys(&entries).is_empty().then_some(entries)
}

/// `storedTagsSchema`: a list of strings.
pub(super) fn tags(value: &Value) -> Option<Vec<String>> {
    let Value::Seq(items) = value else { return None };
    items.iter().map(|item| silent(schema::string(item)).map(str::to_string)).collect()
}

/// The two arms of a node's extension: an embed (which may carry more than
/// Zod's object names, and loses it), or facets and tags alone (which may not).
pub(super) fn node(value: &Value) -> Option<NodeExtension> {
    embed_arm(value).or_else(|| facets_arm(value))
}

fn embed_arm(value: &Value) -> Option<NodeExtension> {
    let entries = object(value)?;
    if get(entries, "kind") != Some(&Value::String("embed".to_string())) {
        return None;
    }
    let id = silent(schema::string(get(entries, "documentId")?))?;
    let version_ref = optional(entries, "versionRef", |v| {
        silent(schema::string(v)).filter(|text| !text.is_empty()).map(str::to_string)
    })
    .ok()?;
    canonical_ulid(id).then(|| NodeExtension {
        embed: Some(NodeEmbed { document_id: id.to_string(), version_ref }),
        facets: caught(entries, "facets", facets),
        tags: caught(entries, "tags", tags),
    })
}

fn facets_arm(value: &Value) -> Option<NodeExtension> {
    let entries = strict(value, &["facets", "tags"])?;
    Some(NodeExtension {
        embed: None,
        facets: caught(entries, "facets", facets),
        tags: caught(entries, "tags", tags),
    })
}

/// `z.object({ x: z.number().int(), y: z.number().int() })`, which keeps what
/// it names and ignores the rest.
fn whole_point(value: &Value) -> Option<CanvasPoint> {
    let entries = object(value)?;
    let x = silent(schema::int(get(entries, "x")?))?;
    let y = silent(schema::int(get(entries, "y")?))?;
    Some(CanvasPoint { x, y })
}

/// An edge's extension: facets, tags and bends, and nothing else.
pub(super) fn edge(value: &Value) -> Option<EdgeExtension> {
    let entries = strict(value, &["facets", "tags", "bends"])?;
    Some(EdgeExtension {
        bends: caught(entries, "bends", |bends| listed(bends, whole_point)),
        facets: caught(entries, "facets", facets),
        tags: caught(entries, "tags", tags),
    })
}

/// A list of one to [`MAX_BENDS`] points.
fn listed(value: &Value, point: fn(&Value) -> Option<CanvasPoint>) -> Option<Vec<CanvasPoint>> {
    let Value::Seq(items) = value else { return None };
    if items.is_empty() || items.len() > MAX_BENDS {
        return None;
    }
    items.iter().map(point).collect()
}

/// `canvasPointSchema`: exactly `x` and `y`, finite.
fn strict_point(value: &Value) -> Option<CanvasPoint> {
    let entries = strict(value, &["x", "y"])?;
    let x = silent(schema::number(get(entries, "x")?))?;
    let y = silent(schema::number(get(entries, "y")?))?;
    Some(CanvasPoint { x, y })
}

fn side(value: &Value) -> Option<EdgeSide> {
    silent(schema::variant(value, EdgeSide::from_wire))
}

fn arrowhead(value: &Value) -> Option<Arrowhead> {
    silent(schema::variant(value, Arrowhead::from_wire))
}

/// A line's end: a node or a free point, told apart by `kind`.
fn line_end(value: &Value) -> Option<LineEnd> {
    let kind = get(object(value)?, "kind")?;
    if kind == &Value::String(LineEndNode::KIND.to_string()) {
        let entries = strict(value, &["kind", "node", "side", "end"])?;
        let node = silent(schema::node_id(get(entries, "node")?))?.to_string();
        let side = optional(entries, "side", side).ok()?;
        let end = optional(entries, "end", arrowhead).ok()?;
        return Some(LineEnd::LineEndNode(LineEndNode { node, side, end }));
    }
    if kind == &Value::String(LineEndPoint::KIND.to_string()) {
        let entries = strict(value, &["kind", "point", "end"])?;
        let point = strict_point(get(entries, "point")?)?;
        let end = optional(entries, "end", arrowhead).ok()?;
        return Some(LineEnd::LineEndPoint(LineEndPoint { point, end }));
    }
    None
}

/// `canvasLineSchema`: ink, strict.
fn line(value: &Value) -> Option<CanvasLine> {
    let entries = strict(value, &["id", "from", "to", "color", "label", "bends", "facets"])?;
    Some(CanvasLine {
        id: silent(schema::node_id(get(entries, "id")?))?.to_string(),
        from: line_end(get(entries, "from")?)?,
        to: line_end(get(entries, "to")?)?,
        color: optional(entries, "color", |v| silent(schema::color(v))).ok()?,
        label: optional(entries, "label", |v| silent(schema::string(v)).map(str::to_string))
            .ok()?,
        bends: optional(entries, "bends", |v| listed(v, strict_point)).ok()?,
        facets: caught(entries, "facets", facets),
    })
}

/// The document's extension: ink, facets and tags. An unknown key is ignored.
pub(super) fn root(value: &Value) -> Option<RootExtension> {
    let entries = object(value)?;
    Some(RootExtension {
        lines: caught(entries, "lines", |lines| {
            let Value::Seq(items) = lines else { return None };
            items.iter().map(line).collect()
        }),
        facets: caught(entries, "facets", facets),
        tags: caught(entries, "tags", tags),
    })
}
