#![cfg(test)]
//! Reading a recorded row into the crate's types and writing its answer back
//! in the recorder's shape. Numbers are compared as doubles, since a JSON
//! integer and the same value written as a float are the one number to
//! JavaScript.

use serde_json::{Map, Value as Json, json};
use std::collections::BTreeMap;
use whiteboard_model::spatial::{
    CanvasEdge, EdgeEnd, NodeEmbed, NodeResource, SpatialCanvas, SpatialNode,
};
use whiteboard_reference_graph::{
    Breach, ContentFacts, DocumentEdit, DocumentEntry, NodeVia, RawReference,
    ReferenceRewriteTooLarge, TagBearer,
};

pub(crate) fn text(value: &Json) -> String {
    value.as_str().expect("a text").to_owned()
}

fn opt_text(value: &Json, key: &str) -> Option<String> {
    value.get(key).map(text)
}

fn texts(value: &Json) -> Vec<String> {
    value.as_array().expect("texts").iter().map(text).collect()
}

fn opt_texts(value: &Json, key: &str) -> Option<Vec<String>> {
    value.get(key).map(texts)
}

fn num(value: &Json) -> f64 {
    value.as_f64().expect("a number")
}

pub(crate) fn count(value: &Json) -> usize {
    usize::try_from(value.as_u64().expect("a count")).expect("a count")
}

fn node_of(node: &Json) -> SpatialNode {
    SpatialNode {
        id: text(&node["id"]),
        x: num(&node["x"]),
        y: num(&node["y"]),
        width: num(&node["width"]),
        height: num(&node["height"]),
        embed: node
            .get("embed")
            .map(|embed| NodeEmbed { document_id: text(&embed["documentId"]), version_ref: None }),
        tags: opt_texts(node, "tags"),
        label: opt_text(node, "label"),
        resource: node.get("resource").map(|resource| NodeResource {
            mime_type: text(&resource["mimeType"]),
            content: opt_text(resource, "content"),
            location: opt_text(resource, "location"),
            subpath: opt_text(resource, "subpath"),
        }),
        ..SpatialNode::default()
    }
}

pub(crate) fn canvas_of(value: &Json) -> SpatialCanvas {
    SpatialCanvas {
        nodes: value["nodes"].as_array().expect("nodes").iter().map(node_of).collect(),
        edges: value["edges"]
            .as_array()
            .expect("edges")
            .iter()
            .map(|edge| CanvasEdge {
                id: text(&edge["id"]),
                from: EdgeEnd { node: text(&edge["from"]["node"]), ..EdgeEnd::default() },
                to: EdgeEnd { node: text(&edge["to"]["node"]), ..EdgeEnd::default() },
                label: opt_text(edge, "label"),
                tags: opt_texts(edge, "tags"),
                ..CanvasEdge::default()
            })
            .collect(),
        tags: opt_texts(value, "tags"),
        ..SpatialCanvas::default()
    }
}

fn put(fields: &mut Map<String, Json>, key: &str, value: Option<Json>) {
    if let Some(value) = value {
        fields.insert(key.to_owned(), value);
    }
}

pub(crate) fn node_json(node: &SpatialNode) -> Json {
    let mut out = Map::new();
    out.insert("id".to_owned(), json!(node.id));
    for (key, value) in
        [("x", node.x), ("y", node.y), ("width", node.width), ("height", node.height)]
    {
        out.insert(key.to_owned(), json!(value));
    }
    put(&mut out, "embed", node.embed.as_ref().map(|e| json!({ "documentId": e.document_id })));
    put(&mut out, "tags", node.tags.as_ref().map(|tags| json!(tags)));
    put(&mut out, "label", node.label.as_ref().map(|label| json!(label)));
    put(
        &mut out,
        "resource",
        node.resource.as_ref().map(|resource| {
            let mut fields = Map::new();
            fields.insert("mimeType".to_owned(), json!(resource.mime_type));
            put(&mut fields, "content", resource.content.as_ref().map(|v| json!(v)));
            put(&mut fields, "location", resource.location.as_ref().map(|v| json!(v)));
            put(&mut fields, "subpath", resource.subpath.as_ref().map(|v| json!(v)));
            Json::Object(fields)
        }),
    );
    Json::Object(out)
}

fn edge_json(edge: &CanvasEdge) -> Json {
    let mut out = Map::new();
    out.insert("id".to_owned(), json!(edge.id));
    out.insert("from".to_owned(), json!({ "node": edge.from.node }));
    out.insert("to".to_owned(), json!({ "node": edge.to.node }));
    put(&mut out, "label", edge.label.as_ref().map(|v| json!(v)));
    put(&mut out, "tags", edge.tags.as_ref().map(|v| json!(v)));
    Json::Object(out)
}

pub(crate) fn canvas_json(canvas: &SpatialCanvas) -> Json {
    let mut out = Map::new();
    out.insert("nodes".to_owned(), canvas.nodes.iter().map(node_json).collect());
    out.insert("edges".to_owned(), canvas.edges.iter().map(edge_json).collect());
    put(&mut out, "tags", canvas.tags.as_ref().map(|v| json!(v)));
    Json::Object(out)
}

/// A recorded content, owned: the borrowed content the crate reads is made from it.
pub(crate) enum Content {
    Markdown(String),
    Spatial(SpatialCanvas),
}

pub(crate) fn content_of(value: &Json) -> Content {
    match value["kind"].as_str() {
        Some("markdown") => Content::Markdown(text(&value["body"])),
        _ => Content::Spatial(canvas_of(&value["canvas"])),
    }
}

pub(crate) fn raw_reference_of(value: &Json) -> RawReference {
    match value["via"].as_str() {
        Some("wikilink") => RawReference::Wikilink {
            target: text(&value["target"]),
            by_id: value["byId"].as_bool().expect("byId"),
            text: text(&value["text"]).into(),
            index: count(&value["index"]),
            length: count(&value["length"]),
        },
        via => RawReference::Node {
            target: text(&value["target"]),
            via: if via == Some("embed-node") { NodeVia::Embed } else { NodeVia::File },
            context: text(&value["context"]),
        },
    }
}

pub(crate) fn reference_json(reference: &RawReference) -> Json {
    match reference {
        RawReference::Wikilink { target, by_id, text, index, length } => json!({
            "target": target, "via": "wikilink", "byId": by_id,
            "text": &**text, "index": index, "length": length,
        }),
        RawReference::Node { target, via, context } => json!({
            "target": target,
            "via": match via { NodeVia::Embed => "embed-node", NodeVia::File => "file-node" },
            "context": context,
        }),
    }
}

fn bearer_json(bearer: &TagBearer) -> Json {
    let mut out = Map::new();
    out.insert("what".to_owned(), json!(bearer.what.as_str()));
    put(&mut out, "id", bearer.id.as_ref().map(|v| json!(v)));
    out.insert("text".to_owned(), json!(bearer.text));
    out.insert("tags".to_owned(), json!(bearer.tags));
    Json::Object(out)
}

pub(crate) fn bearers_json(bearers: &[TagBearer]) -> Json {
    bearers.iter().map(bearer_json).collect()
}

pub(crate) fn facts_json(facts: &ContentFacts) -> Json {
    json!({
        "refs": facts.refs.iter().map(reference_json).collect::<Vec<_>>(),
        "texts": facts.texts,
        "bearers": bearers_json(&facts.bearers),
    })
}

pub(crate) fn entries_of(value: &Json) -> Vec<DocumentEntry> {
    value
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| DocumentEntry {
            document_id: text(&entry["documentId"]),
            path: text(&entry["path"]),
            name: opt_text(entry, "name"),
            kind: opt_text(entry, "kind"),
        })
        .collect()
}

/// The recorded facts of a listing: each document's references and texts.
pub(crate) fn facts_of(value: &Json) -> BTreeMap<String, (Vec<RawReference>, Vec<String>)> {
    value
        .as_array()
        .expect("facts")
        .iter()
        .map(|pair| {
            let refs = pair[1]["refs"].as_array().expect("refs");
            (
                text(&pair[0]),
                (refs.iter().map(raw_reference_of).collect(), texts(&pair[1]["texts"])),
            )
        })
        .collect()
}

pub(crate) fn breach_of(value: &Json) -> Breach {
    match value["shape"].as_str() {
        Some("body") => Breach::Body { chars: count(&value["chars"]) },
        _ => Breach::NodeText { chars: count(&value["chars"]), node_id: text(&value["nodeId"]) },
    }
}

fn breach_json(breach: &Breach) -> Json {
    match breach {
        Breach::Body { chars } => json!({ "shape": "body", "chars": chars }),
        Breach::NodeText { chars, node_id } => {
            json!({ "shape": "node-text", "chars": chars, "nodeId": node_id })
        }
    }
}

pub(crate) fn ok(value: impl Into<Json>) -> Json {
    json!({ "ok": value.into() })
}

pub(crate) fn refused(error: &ReferenceRewriteTooLarge) -> Json {
    json!({ "err": ReferenceRewriteTooLarge::NAME, "breach": breach_json(&error.breach) })
}

pub(crate) fn edit_json(edit: &DocumentEdit) -> Json {
    match edit {
        DocumentEdit::MarkdownSplices(runs) => json!({
            "kind": "markdown-splices",
            "runs": runs.iter().map(|run| json!({
                "index": run.index, "remove": run.remove, "insert": run.insert,
            })).collect::<Vec<_>>(),
        }),
        DocumentEdit::MarkdownBody(body) => json!({ "kind": "markdown-body", "body": body }),
        DocumentEdit::SpatialCanvas { before, after } => json!({
            "kind": "spatial-canvas",
            "before": canvas_json(before),
            "after": canvas_json(after),
        }),
        DocumentEdit::SpatialNodes(nodes) => json!({
            "kind": "spatial-nodes",
            "nodes": nodes.iter().map(node_json).collect::<Vec<_>>(),
        }),
    }
}

/// Every number as a double, so `0` and `0.0` are one value.
pub(crate) fn doubles(value: &Json) -> Json {
    match value {
        Json::Number(number) => json!(number.as_f64()),
        Json::Array(items) => items.iter().map(doubles).collect(),
        Json::Object(fields) => {
            Json::Object(fields.iter().map(|(k, v)| (k.clone(), doubles(v))).collect())
        }
        other => other.clone(),
    }
}
