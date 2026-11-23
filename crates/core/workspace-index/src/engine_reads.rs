//! The document engine's reads over a workspace record: what the record lists,
//! and the content queries of a document hosted on one of its tree nodes.
//!
//! Each answers as `read` of `contracts/crdt/document-engine.schema.json`
//! does, `{ ok: value }` or `{ err: class }`, and answers `None` for a query
//! it leaves to the caller: one that names an argument it does not read, or
//! one `whiteboard-crdt` answers over a document of its own.

use crate::node_meta::{DocumentMeta, NodeRead, WORKSPACE_TREE_KEY};
use crate::record::{PlacedDocument, WorkspaceRecord};
use crate::trash::TrashRow;
use crate::walk::{Walked, walk, walk_naming_unreadable};
use whiteboard_crdt::{
    CONTENT_QUERIES, Entry, LoroDoc, NodeAt, answer_content_query, peek, project_node, tree,
};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName, ReadResponse};

const WORKSPACE_META_KEY: &str = "workspaceMeta";

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn map<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Map(entries.into_iter().map(|(key, held)| (key.to_owned(), held)).collect())
}

fn with(
    mut entries: Vec<(String, Value)>,
    key: &str,
    value: Option<Value>,
) -> Vec<(String, Value)> {
    if let Some(value) = value {
        entries.push((key.to_owned(), value));
    }
    entries
}

fn ok(value: Value) -> ReadResponse {
    ReadResponse { value: map([("ok", value)]) }
}

fn refused(class: &str) -> ReadResponse {
    ReadResponse { value: map([("err", text(class))]) }
}

/// A document's stored meta as a listing shows it: a key the node does not
/// hold is absent, not null.
fn meta_value(meta: &DocumentMeta) -> Vec<(String, Value)> {
    let entries = vec![
        ("documentId".to_owned(), text(&meta.document_id)),
        ("segment".to_owned(), text(&meta.segment)),
        ("kind".to_owned(), text(&meta.kind)),
    ];
    let entries = with(entries, "name", meta.name.as_deref().map(text));
    let entries = with(entries, "nameChosen", meta.name_chosen.then_some(Value::Bool(true)));
    let entries = with(entries, "createdAt", meta.created_at.map(Value::Number));
    with(entries, "updatedAt", meta.updated_at.map(Value::Number))
}

fn document_entry((placed, shadowed): &(PlacedDocument, bool)) -> Value {
    let entries = with(meta_value(&placed.meta), "path", Some(text(&placed.path)));
    let entries = with(entries, "contentDigest", Some(text(&placed.content_digest)));
    Value::Map(with(entries, "shadowed", shadowed.then_some(Value::Bool(true))))
}

fn node_entry(walked: &Walked) -> Value {
    match &walked.read {
        NodeRead::Document(meta) => map([
            ("type", text("document")),
            ("meta", Value::Map(meta_value(meta))),
            ("path", text(&walked.path)),
        ]),
        NodeRead::Folder { segment, name } => {
            let entries = vec![
                ("type".to_owned(), text("folder")),
                ("segment".to_owned(), text(segment)),
                ("path".to_owned(), text(&walked.path)),
            ];
            Value::Map(with(entries, "name", name.as_deref().map(text)))
        }
    }
}

fn trash_entry(row: &TrashRow) -> Value {
    let blob = map([("algorithm", text(&row.algorithm)), ("digestHex", text(&row.digest_hex))]);
    let entries = vec![
        ("documentId".to_owned(), text(&row.document_id)),
        ("path".to_owned(), text(&row.path)),
        ("deletedAt".to_owned(), number(row.deleted_at)),
        ("blob".to_owned(), blob),
    ];
    let entries = with(entries, "name", row.name.as_deref().map(text));
    let folders = row.folder_names.as_ref().map(|rows| {
        Value::Seq(
            rows.iter()
                .map(|(path, name)| map([("path", text(path)), ("name", text(name))]))
                .collect(),
        )
    });
    Value::Map(with(entries, "folderNames", folders))
}

#[expect(
    clippy::cast_precision_loss,
    reason = "a stored time is a safe integer, which a double holds exactly"
)]
fn number(value: u64) -> Value {
    Value::Number(value as f64)
}

/// `lastCompactedAt`, when the record stores one that is an integer.
fn workspace_meta(doc: &LoroDoc) -> Value {
    let stored = peek(doc, &format!("{WORKSPACE_META_KEY}/lastCompactedAt"));
    match stored {
        Some(Entry::Value(Value::Number(at))) if at.fract() == 0.0 && at.is_finite() => {
            map([("lastCompactedAt", Value::Number(at))])
        }
        _ => Value::Map(Vec::new()),
    }
}

fn unreadable_nodes(doc: &LoroDoc) -> Value {
    let Some(held) = tree(doc, WORKSPACE_TREE_KEY) else { return Value::Seq(Vec::new()) };
    let (_, skipped) = walk_naming_unreadable(&held, held.roots(), "");
    Value::Seq(skipped.iter().map(|node| text(&node.to_string())).collect())
}

fn seq<T>(rows: impl IntoIterator<Item = T>, show: impl Fn(T) -> Value) -> Value {
    Value::Seq(rows.into_iter().map(show).collect())
}

/// The reads of the record itself, which take no argument.
fn answer_record_query(doc: &LoroDoc, name: QueryName) -> Option<ReadResponse> {
    let record = || WorkspaceRecord::over(doc);
    Some(ok(match name {
        QueryName::Documents => seq(record().placed_documents().iter(), document_entry),
        QueryName::Nodes => seq(walk(doc).0.iter(), node_entry),
        QueryName::Meta => workspace_meta(doc),
        QueryName::Pinned => seq(record().pinned(), |id| text(&id)),
        QueryName::Trash => seq(record().trash().iter(), trash_entry),
        QueryName::FolderNames => seq(record().folder_names(), |(path, name)| {
            map([("path", text(&path)), ("name", text(&name))])
        }),
        QueryName::UnreadableNodes => unreadable_nodes(doc),
        _ => return None,
    }))
}

/// The query's arguments but the document it names, and that document.
fn hosted(query: &Query) -> Option<(String, Value)> {
    let Some(Value::Map(args)) = &query.args else { return None };
    let (id, rest): (Vec<_>, Vec<_>) =
        args.iter().cloned().partition(|(key, _)| key == "documentId");
    let Some((_, Value::String(id))) = id.into_iter().next() else { return None };
    Some((id, Value::Map(rest)))
}

/// A content query asked of the document hosted on the node that carries
/// `document_id`, answered over the document that node holds. A document the
/// record does not hold is refused as the TypeScript refuses it: the whole-document
/// reads say it is out of range, the rest that there is no such document.
fn answer_hosted(doc: &LoroDoc, query: &Query, document_id: &str, rest: Value) -> ReadResponse {
    let found = walk(doc).0.into_iter().find(|walked| {
        matches!(&walked.read, NodeRead::Document(meta) if meta.document_id == document_id)
    });
    let missing = match query.query {
        QueryName::StateSize
        | QueryName::ContentDigest
        | QueryName::TextLimitBreach
        | QueryName::DocumentJudgement => "RangeError",
        _ => "Error",
    };
    let Some(found) = found else { return refused(missing) };
    let at = NodeAt { doc, tree: WORKSPACE_TREE_KEY, node: found.id };
    let Ok(projected) = project_node(at) else { return refused(missing) };
    let asked = Query { query: query.query, args: Some(rest) };
    answer_content_query(&projected, &asked).unwrap_or_else(|| refused("TypeError"))
}

/// Answers `query` over a workspace record, `None` for a query it does not read.
#[must_use]
pub fn answer_workspace_query(doc: &LoroDoc, query: &Query) -> Option<ReadResponse> {
    if let Some((document_id, rest)) = hosted(query) {
        return CONTENT_QUERIES
            .contains(&query.query)
            .then(|| answer_hosted(doc, query, &document_id, rest));
    }
    match &query.args {
        None => answer_record_query(doc, query.query),
        Some(Value::Map(args)) if args.is_empty() => answer_record_query(doc, query.query),
        Some(_) => None,
    }
}
