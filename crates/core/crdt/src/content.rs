//! A document's content queries over the document that is the root of its own
//! `LoroDoc`: the kind, the markdown body and its marks, the locks, the facet
//! bucket, and the shapes an older writer left, which are refused by name.
//!
//! Each answers as `read` of `contracts/crdt/document-engine.schema.json`
//! does: `{ ok: value }`, or `{ err: class }` with the class the TypeScript
//! refuses with. Every read looks without opening: asking a document for a
//! root it never held registers an empty one, which the next snapshot then
//! carries. A container is resolved once per query, never per entry.

use crate::plain::{Undecided, plain, plain_object, undefined};
use crate::{annotations, canvas, envelope, image_refs, judgement, proposals, stored};
use loro::{ContainerType, LoroDoc, LoroMap, LoroText, LoroValue, TextDelta, ValueOrContainer};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName, ReadResponse};

const DOCUMENT_KEY: &str = "document";
const BODY_KEY: &str = "body";
const NODES_KEY: &str = "nodes";
const EDGES_KEY: &str = "edges";
const CANVAS_KEY: &str = "canvas";
const FACETS_KEY: &str = "facets";
const NODE_LOCKS_KEY: &str = "nodeLocks";
const EDGE_LOCKS_KEY: &str = "edgeLocks";
const RETIRED_COMMENTS_KEY: &str = "comments";
const RETIRED_ELEMENTS_KEY: &str = "elements";
/// The key a node, an edge or the canvas map was stored under before the model
/// stopped being the format.
const PRE_ADR_0037_EXTENSION_KEY: &str = "x-whiteboard";
/// The id of the one text node an older writer stored a markdown body in.
const RETIRED_BODY_NODE_ID: &str = "okf-body";
/// The class a refusal of a retired shape is answered as.
const RETIRED_SHAPE_REFUSAL: &str = "RetiredStoredShapeError";

/// What a document is: a canvas, or an OKF markdown body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind {
    Spatial,
    Markdown,
}

/// The classes of refusal a query answers with, which cross the contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal(pub &'static str);

pub(crate) fn map_of(doc: &LoroDoc, key: &str) -> LoroMap {
    doc.get_map(key)
}

pub(crate) fn text_of(doc: &LoroDoc) -> LoroText {
    doc.get_text(BODY_KEY)
}

/// A map entry's plain value; a container, which the readers here never see
/// written, is not a value.
pub(crate) fn value_of(held: ValueOrContainer) -> Option<LoroValue> {
    match held {
        ValueOrContainer::Value(value) => Some(value),
        ValueOrContainer::Container(_) => None,
    }
}

/// The kind the document's envelope states: `None` for none, and for a kind
/// this build does not recognise, which a newer peer can write.
#[must_use]
pub fn document_kind(doc: &LoroDoc) -> Option<DocumentKind> {
    let stated = map_of(doc, DOCUMENT_KEY).get("kind").and_then(value_of)?;
    match stated {
        LoroValue::String(kind) if kind.as_str() == "spatial" => Some(DocumentKind::Spatial),
        LoroValue::String(kind) if kind.as_str() == "markdown" => Some(DocumentKind::Markdown),
        _ => None,
    }
}

/// Whether a map holds the key at all, whatever it holds.
fn holds(map: &LoroMap, key: &str) -> bool {
    map.get(key).is_some()
}

/// The first entry of `map`, in the map's key order, that `shape_of` finds retired.
pub(crate) fn first_retired(
    map: &LoroMap,
    shape_of: impl Fn(&str, Option<&LoroValue>) -> Option<String>,
) -> Option<String> {
    map.keys().find_map(|id| shape_of(&id, map.get(&id).and_then(value_of).as_ref()))
}

fn record_key<'a>(value: Option<&'a LoroValue>, key: &str) -> Option<&'a LoroValue> {
    match value {
        Some(LoroValue::Map(entries)) => entries.get(key),
        _ => None,
    }
}

/// What retired shape one stored node value is in.
pub(crate) fn retired_node_shape(id: &str, raw: Option<&LoroValue>) -> Option<String> {
    if record_key(raw, PRE_ADR_0037_EXTENSION_KEY).is_some() {
        return Some(format!(
            "node \"{id}\" stored under the pre-ADR-0037 `{PRE_ADR_0037_EXTENSION_KEY}` key"
        ));
    }
    match record_key(raw, "type") {
        Some(LoroValue::String(kind))
            if ["text", "file", "link", "group"].contains(&kind.as_str()) =>
        {
            Some(format!(
                "node \"{id}\" stored in the pre-ADR-0038 node-kind union (type \"{}\")",
                kind.as_str()
            ))
        }
        _ => None,
    }
}

/// What retired shape one stored edge value is in.
pub(crate) fn retired_edge_shape(id: &str, raw: Option<&LoroValue>) -> Option<String> {
    record_key(raw, PRE_ADR_0037_EXTENSION_KEY).map(|_| {
        format!("edge \"{id}\" stored under the pre-ADR-0037 `{PRE_ADR_0037_EXTENSION_KEY}` key")
    })
}

/// A markdown body stored as the `okf-body` canvas text node: only an empty
/// body container can hide it, since one with text is the current body.
fn retired_markdown_body_shape(doc: &LoroDoc) -> Option<String> {
    if !holds(&map_of(doc, NODES_KEY), RETIRED_BODY_NODE_ID) || !text_of(doc).is_empty() {
        return None;
    }
    Some(format!("a markdown body stored as the `{RETIRED_BODY_NODE_ID}` canvas text node"))
}

/// A markdown document with an empty body whose canvas holds a node carrying
/// text: a body stored as a text node under some other id.
pub(crate) fn retired_markdown_canvas_shape(doc: &LoroDoc) -> Option<String> {
    if !text_of(doc).is_empty() {
        return None;
    }
    let nodes = map_of(doc, NODES_KEY);
    let holds_text = nodes.keys().any(|id| {
        let raw = nodes.get(&id).and_then(value_of);
        let resource = record_key(raw.as_ref(), "resource");
        matches!(record_key(resource, "content"), Some(LoroValue::String(_)))
    });
    holds_text.then(|| "a markdown body stored as a canvas text node".to_owned())
}

/// The retired shape of a markdown body, asked by the document's kind: none of
/// a spatial document, where a text node is content.
fn retired_markdown_shape(doc: &LoroDoc) -> Option<String> {
    let kind = document_kind(doc);
    if kind == Some(DocumentKind::Spatial) {
        return None;
    }
    retired_markdown_body_shape(doc).or_else(|| {
        if kind == Some(DocumentKind::Markdown) { retired_markdown_canvas_shape(doc) } else { None }
    })
}

/// The retired Excalidraw `elements` list, when it still holds entries. An
/// empty root is what an old client leaves by opening it and carries nothing.
fn retired_elements_shape(doc: &LoroDoc) -> Option<String> {
    let LoroValue::Map(roots) = doc.get_value() else { return None };
    let Some(LoroValue::Container(id)) = roots.get(RETIRED_ELEMENTS_KEY) else { return None };
    let entries = match id.container_type() {
        ContainerType::List => doc.get_list(RETIRED_ELEMENTS_KEY).len(),
        ContainerType::MovableList => doc.get_movable_list(RETIRED_ELEMENTS_KEY).len(),
        _ => return None,
    };
    (entries > 0).then(|| {
        format!(
            "canvas elements stored as the retired Excalidraw `{RETIRED_ELEMENTS_KEY}` list ({entries} entries)"
        )
    })
}

/// The first retired node, edge or canvas-settings shape, in that order.
fn retired_canvas_record(doc: &LoroDoc) -> Option<String> {
    first_retired(&map_of(doc, NODES_KEY), retired_node_shape)
        .or_else(|| first_retired(&map_of(doc, EDGES_KEY), retired_edge_shape))
        .or_else(|| {
            holds(&map_of(doc, CANVAS_KEY), PRE_ADR_0037_EXTENSION_KEY).then(|| {
                format!(
                    "canvas settings stored under the pre-ADR-0037 `{PRE_ADR_0037_EXTENSION_KEY}` key"
                )
            })
        })
}

/// The first retired shape a canvas holds: what refuses a read of it.
pub(crate) fn retired_canvas_shape(doc: &LoroDoc) -> Option<String> {
    retired_canvas_record(doc).or_else(|| retired_elements_shape(doc))
}

/// The first retired shape the document holds, which no reader serves.
#[must_use]
pub fn retired_stored_shape(doc: &LoroDoc) -> Option<String> {
    retired_canvas_record(doc)
        .or_else(|| retired_markdown_shape(doc))
        .or_else(|| retired_elements_shape(doc))
}

/// The markdown body, refused when an older writer stored it as a canvas node.
pub fn markdown_body(doc: &LoroDoc) -> Result<String, Refusal> {
    if retired_markdown_shape(doc).is_some() {
        return Err(Refusal(RETIRED_SHAPE_REFUSAL));
    }
    Ok(text_of(doc).to_string())
}

/// The body's runs, each with the marks over it, as `toDelta` answers them.
fn body_delta(doc: &LoroDoc) -> Option<Value> {
    let mut runs = Vec::new();
    for delta in text_of(doc).to_delta() {
        let TextDelta::Insert { insert, attributes } = delta else { continue };
        let mut run = vec![("insert".to_owned(), Value::String(insert))];
        if let Some(marks) = attributes {
            let marks = plain_object(marks.iter())?;
            run.push(("attributes".to_owned(), marks));
        }
        runs.push(Value::Map(run));
    }
    Some(Value::Seq(runs))
}

/// The ids a lock map holds `true` for, in the order `Array.prototype.sort`
/// puts them: by UTF-16 code unit, which is not the order of code points.
fn locks(doc: &LoroDoc, key: &str) -> Value {
    let map = map_of(doc, key);
    let mut locked: Vec<String> = map
        .keys()
        .filter(|id| matches!(map.get(id).and_then(value_of), Some(LoroValue::Bool(true))))
        .map(|id| id.to_string())
        .collect();
    locked.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Value::Seq(locked.into_iter().map(Value::String).collect())
}

/// The extension-facet bucket, each entry a reader can read.
fn facets(doc: &LoroDoc) -> Option<Value> {
    let map = map_of(doc, FACETS_KEY);
    let mut shown = Vec::new();
    for key in map.keys().filter(|key| stored::is_readable_facet_key(key)) {
        let held = map.get(&key).and_then(value_of).unwrap_or(LoroValue::Null);
        shown.push((key.to_string(), plain(&held)?));
    }
    shown.sort_by(|a, b| a.0.cmp(&b.0));
    Some(Value::Map(shown))
}

pub(crate) fn ok(value: Value) -> ReadResponse {
    ReadResponse { value: Value::Map(vec![("ok".to_owned(), value)]) }
}

fn refused(Refusal(class): Refusal) -> ReadResponse {
    ReadResponse { value: Value::Map(vec![("err".to_owned(), Value::String(class.to_owned()))]) }
}

/// The content queries this crate answers, by the contract's name.
pub const CONTENT_QUERIES: [QueryName; 24] = [
    QueryName::DocumentKind,
    QueryName::NodeLocks,
    QueryName::EdgeLocks,
    QueryName::MarkdownBody,
    QueryName::BodyDelta,
    QueryName::Facets,
    QueryName::RetiredStoredShape,
    QueryName::RetiredCommentRows,
    QueryName::SpatialCanvas,
    QueryName::SpatialNodeCount,
    QueryName::DocumentContent,
    QueryName::DocumentContentWithTags,
    QueryName::CoreFacets,
    QueryName::TrustFacets,
    QueryName::Annotations,
    QueryName::CommentThreads,
    QueryName::ThreadMessageCounts,
    QueryName::ThreadMarks,
    QueryName::Proposals,
    QueryName::ImageRefIds,
    QueryName::StateSize,
    QueryName::ContentDigest,
    QueryName::TextLimitBreach,
    QueryName::DocumentJudgement,
];

/// Answers `query` over a document that is the root of its own `LoroDoc`, or
/// `None` for a query this crate does not answer yet, or one that names a
/// document hosted on a workspace tree node (`args.documentId`).
#[must_use]
pub fn answer_content_query(doc: &LoroDoc, query: &Query) -> Option<ReadResponse> {
    if hosted_on_a_node(query) {
        return None;
    }
    Some(match query.query {
        QueryName::DocumentKind => ok(document_kind(doc).map_or_else(undefined, |kind| {
            Value::String(
                match kind {
                    DocumentKind::Spatial => "spatial",
                    DocumentKind::Markdown => "markdown",
                }
                .to_owned(),
            )
        })),
        QueryName::NodeLocks => ok(locks(doc, NODE_LOCKS_KEY)),
        QueryName::EdgeLocks => ok(locks(doc, EDGE_LOCKS_KEY)),
        QueryName::MarkdownBody => match markdown_body(doc) {
            Ok(body) => ok(Value::String(body)),
            Err(refusal) => refused(refusal),
        },
        QueryName::BodyDelta => ok(body_delta(doc)?),
        QueryName::Facets => ok(facets(doc)?),
        QueryName::RetiredStoredShape => {
            ok(retired_stored_shape(doc).map_or(Value::Null, Value::String))
        }
        QueryName::RetiredCommentRows => {
            let rows = f64::from(
                u32::try_from(map_of(doc, RETIRED_COMMENTS_KEY).len()).unwrap_or(u32::MAX),
            );
            ok(Value::Number(rows))
        }
        _ => return answer_document_query(doc, query),
    })
}

/// The queries over a document's whole content: the canvas, the half its kind
/// names, and the envelope facets.
fn answer_document_query(doc: &LoroDoc, query: &Query) -> Option<ReadResponse> {
    Some(match query.query {
        QueryName::SpatialCanvas => match canvas::spatial_canvas(doc) {
            Ok(value) => ok(value?),
            Err(refusal) => refused(refusal),
        },
        QueryName::SpatialNodeCount => ok(canvas::spatial_node_count(doc)),
        QueryName::DocumentContent | QueryName::DocumentContentWithTags => {
            let asked = kind_asked_by(query).ok()?;
            match canvas::document_content(doc, asked) {
                Ok(content) => ok(match query.query {
                    QueryName::DocumentContent => content?.value,
                    _ => canvas::content_with_tags(content?),
                }),
                Err(refusal) => refused(refusal),
            }
        }
        QueryName::CoreFacets => {
            ok(envelope::core_facets(doc).map_or_else(|| Some(undefined()), |core| core.value())?)
        }
        QueryName::TrustFacets => ok(envelope::trust_facets(doc).ok()?.unwrap_or_else(undefined)),
        _ => return answer_annotation_query(doc, query),
    })
}

/// The queries over the annotation layer and what a document references.
fn answer_annotation_query(doc: &LoroDoc, query: &Query) -> Option<ReadResponse> {
    if !takes_no_arguments(query) {
        return None;
    }
    Some(match query.query {
        QueryName::Annotations => match annotations::annotations(doc) {
            Ok(threads) => ok(threads),
            Err(refusal) => refused(refusal),
        },
        QueryName::CommentThreads => ok(annotations::comment_threads(doc)),
        QueryName::ThreadMessageCounts => ok(annotations::thread_message_counts(doc)),
        QueryName::ThreadMarks => ok(annotations::thread_marks(doc)),
        QueryName::Proposals => ok(proposals::proposals(doc)?),
        QueryName::ImageRefIds => match image_refs::image_ref_ids(doc) {
            Ok(ids) => ok(ids),
            Err(refusal) => refused(refusal),
        },
        _ => return judgement::answer(doc, query),
    })
}

/// The kind a content read is asked to fall back to, `None` for none; an
/// argument the contract's reader refuses is undecided, its refusal being its own.
fn kind_asked_by(query: &Query) -> Result<Option<DocumentKind>, Undecided> {
    // The reader parses `query.args ?? {}`, so null is no arguments and any
    // other non-object is refused by its object schema.
    let args = match &query.args {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Map(args)) => args,
        Some(_) => return Err(Undecided),
    };
    match args.as_slice() {
        [] => Ok(None),
        [(key, Value::String(kind))] if key == "kind" => match kind.as_str() {
            "spatial" => Ok(Some(DocumentKind::Spatial)),
            "markdown" => Ok(Some(DocumentKind::Markdown)),
            _ => Err(Undecided),
        },
        _ => Err(Undecided),
    }
}

/// Whether the query names no argument, the only form these reads are answered in.
fn takes_no_arguments(query: &Query) -> bool {
    match &query.args {
        None => true,
        Some(Value::Map(args)) => args.is_empty(),
        Some(_) => false,
    }
}

fn hosted_on_a_node(query: &Query) -> bool {
    match &query.args {
        Some(Value::Map(args)) => args.iter().any(|(key, _)| key == "documentId"),
        _ => false,
    }
}
