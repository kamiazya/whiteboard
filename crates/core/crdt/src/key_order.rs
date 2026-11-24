//! The key order of each object a read hands back through one of the model's
//! schemas, so an answer spells its objects as the TypeScript's does.
//!
//! A zod object builds a fresh JavaScript object as it parses: the keys its
//! shape declares, in the order it declares them, then (for a loose object)
//! any other key the input held. A JavaScript object enumerates every
//! array-index key first, ascending, whatever order it was written in. So an
//! object read through a schema is written here in that order: array-index
//! keys, then the shape's, then the rest in the order already held. A free map
//! (a facet payload, `facetsRaw`) is not reordered: npm loro-crdt hands one
//! over in the order of its hash map, which a native build cannot know.
//!
//! Each list below is the shape of the zod schema it names, in
//! `packages/model`; the spatial and OKF ones are generated from
//! `contracts/model`, which `tests` holds them to.

use whiteboard_model::{Value, array_index};

/// `storedCoreFacetsSchema`: `coreFacetsSchema` without `title`, then `facetsRaw`.
pub(crate) const CORE: &[&str] = &["type", "description", "resource", "tags", "view", "facetsRaw"];
/// `trustFacetsSchema`.
pub(crate) const TRUST: &[&str] = &["generated", "verified"];
/// `okfTrustEventSchema`, a loose object: a key a producer added follows.
pub(crate) const TRUST_EVENT: &[&str] = &["by", "at"];

/// `commentThreadSchema`.
pub(crate) const THREAD: &[&str] = &["id", "anchor", "status", "createdAt", "messages"];
/// `commentMessageSchema`.
pub(crate) const MESSAGE: &[&str] = &["id", "body", "author", "createdAt", "editedAt"];
/// `annotationAnchorSchema`'s `spatial` arm.
pub(crate) const SPATIAL_ANCHOR: &[&str] =
    &["kind", "nodeId", "edgeId", "nodeIds", "x", "y", "width", "height"];
/// `textAnchorSchema`, the `text` arm.
pub(crate) const TEXT_ANCHOR: &[&str] = &["kind", "nodeId", "quote", "start", "end"];
/// `textQuoteSelectorSchema`.
pub(crate) const QUOTE: &[&str] = &["prefix", "exact", "suffix"];

/// `proposalSchema`.
pub(crate) const PROPOSAL: &[&str] = &["id", "author", "createdAt", "changes"];
/// `proposedChangeSchema`, every arm at once: `changeIdentity`, `op`, then
/// the arm's own keys. No two arms share a key past `op` but `assumed` and
/// `patch`, and every arm that holds them holds them last, in this order.
pub(crate) const CHANGE: &[&str] = &[
    "id", "status", "op", "node", "edge", "line", "nodeId", "edgeId", "lineId", "anchor", "patch",
    "text", "assumed",
];

/// `spatialNodeSchema`: `sharedNodeFieldsSchema` extended.
pub(crate) const NODE: &[&str] = &[
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
];
/// `nodeResourceSchema`.
pub(crate) const RESOURCE: &[&str] = &["mimeType", "content", "location", "subpath"];
/// `canvasEdgeSchema`.
pub(crate) const EDGE: &[&str] = &["id", "from", "to", "color", "label", "bends", "facets", "tags"];
/// `edgeEndSchema`.
pub(crate) const EDGE_END: &[&str] = &["node", "side", "end"];
/// `canvasLineSchema`.
pub(crate) const LINE: &[&str] = &["id", "from", "to", "color", "label", "bends", "facets"];
/// `lineEndSchema`, both arms at once: `node` and `point` never meet.
pub(crate) const LINE_END: &[&str] = &["kind", "node", "point", "side", "end"];
/// `nodePatchFieldsSchema`.
pub(crate) const NODE_PATCH: &[&str] = &[
    "x",
    "y",
    "width",
    "height",
    "color",
    "text",
    "file",
    "subpath",
    "url",
    "label",
    "background",
    "backgroundStyle",
];
/// `spatialCanvasSchema`.
pub(crate) const CANVAS: &[&str] = &["nodes", "edges", "lines", "facets", "tags"];

/// Where `key` goes: array indices first, then the shape's keys, then the rest.
fn rank(key: &str, shape: &[&str]) -> (u8, u32, usize) {
    if let Some(index) = array_index(key) {
        return (0, index, 0);
    }
    match shape.iter().position(|held| *held == key) {
        Some(at) => (1, 0, at),
        None => (2, 0, 0),
    }
}

/// `value`'s entries in the order a JavaScript object parsed by a schema of
/// `shape` enumerates them, each first rewritten by `nested`. Any other value
/// is handed back as it is.
pub(crate) fn shaped(value: Value, shape: &[&str], nested: fn(&str, Value) -> Value) -> Value {
    let Value::Map(entries) = value else { return value };
    let mut entries: Vec<(String, Value)> =
        entries.into_iter().map(|(key, held)| (key.clone(), nested(&key, held))).collect();
    entries.sort_by_key(|(key, _)| rank(key, shape));
    Value::Map(entries)
}

/// No object below this one is read through a schema.
fn flat(_: &str, value: Value) -> Value {
    value
}

fn each(value: Value, item: fn(Value) -> Value) -> Value {
    match value {
        Value::Seq(items) => Value::Seq(items.into_iter().map(item).collect()),
        other => other,
    }
}

/// The text an object holds at `name`: the arm a union discriminates on.
fn text_at<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    let Value::Map(entries) = value else { return None };
    entries.iter().find(|(key, _)| key == name).and_then(|(_, held)| match held {
        Value::String(text) => Some(text.as_str()),
        _ => None,
    })
}

/// The core facets.
pub(crate) fn core(value: Value) -> Value {
    shaped(value, CORE, flat)
}

fn trust_event(value: Value) -> Value {
    shaped(value, TRUST_EVENT, flat)
}

/// The trust facets, each stamp a trust event.
pub(crate) fn trust(value: Value) -> Value {
    shaped(value, TRUST, |key, held| match key {
        "generated" => trust_event(held),
        "verified" => each(held, trust_event),
        _ => held,
    })
}

fn text_anchor(value: Value) -> Value {
    shaped(value, TEXT_ANCHOR, |key, held| match key {
        "quote" => shaped(held, QUOTE, flat),
        _ => held,
    })
}

/// An annotation anchor, by its arm; the `document` arm holds one key.
fn anchor(value: Value) -> Value {
    match text_at(&value, "kind") {
        Some("text") => text_anchor(value),
        Some("spatial") => shaped(value, SPATIAL_ANCHOR, flat),
        _ => value,
    }
}

/// A comment thread and its messages.
pub(crate) fn thread(value: Value) -> Value {
    shaped(value, THREAD, |key, held| match key {
        "anchor" => anchor(held),
        "messages" => each(held, |message| shaped(message, MESSAGE, flat)),
        _ => held,
    })
}

/// A stored node.
pub(crate) fn node(value: Value) -> Value {
    shaped(value, NODE, |key, held| match key {
        "resource" => shaped(held, RESOURCE, flat),
        _ => held,
    })
}

// A point's keys (a bend's, a free end's) and an embed's are ascending as
// `plain` writes them, which is `canvasPointSchema`'s and `nodeEmbedSchema`'s
// order: neither is reordered.

fn edge_field(key: &str, held: Value) -> Value {
    match key {
        "from" | "to" => shaped(held, EDGE_END, flat),
        _ => held,
    }
}

fn line_field(key: &str, held: Value) -> Value {
    match key {
        "from" | "to" => shaped(held, LINE_END, flat),
        _ => held,
    }
}

/// A stored edge.
pub(crate) fn edge(value: Value) -> Value {
    shaped(value, EDGE, edge_field)
}

/// A stored line.
pub(crate) fn line(value: Value) -> Value {
    shaped(value, LINE, line_field)
}

/// The canvas a spatial document holds.
pub(crate) fn canvas(value: Value) -> Value {
    shaped(value, CANVAS, |key, held| match key {
        "nodes" => each(held, node),
        "edges" => each(held, edge),
        "lines" => each(held, line),
        _ => held,
    })
}

/// A proposed change, its payload in the shape its verb names.
fn change(value: Value) -> Value {
    let subject: fn(&str, Value) -> Value = match text_at(&value, "op") {
        Some("node.add" | "node.remove") => |key, held| match key {
            "node" | "assumed" => node(held),
            _ => held,
        },
        Some("edge.add" | "edge.remove") => |key, held| match key {
            "edge" | "assumed" => edge(held),
            _ => held,
        },
        Some("line.add" | "line.remove") => |key, held| match key {
            "line" | "assumed" => line(held),
            _ => held,
        },
        Some("node.patch") => |key, held| match key {
            "patch" | "assumed" => shaped(held, NODE_PATCH, flat),
            _ => held,
        },
        // `edgePatchFieldsSchema` and `linePatchFieldsSchema` are the element's
        // shape without its identity, so the element's order holds for them.
        Some("edge.patch") => |key, held| match key {
            "patch" | "assumed" => shaped(held, EDGE, edge_field),
            _ => held,
        },
        Some("line.patch") => |key, held| match key {
            "patch" | "assumed" => shaped(held, LINE, line_field),
            _ => held,
        },
        Some("body.replace") => |key, held| match key {
            "anchor" => text_anchor(held),
            _ => held,
        },
        _ => flat,
    };
    shaped(value, CHANGE, subject)
}

/// A proposal and its changes.
pub(crate) fn proposal(value: Value) -> Value {
    shaped(value, PROPOSAL, |key, held| match key {
        "changes" => each(held, change),
        _ => held,
    })
}

#[cfg(test)]
mod tests;
