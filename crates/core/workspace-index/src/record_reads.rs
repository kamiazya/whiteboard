//! The document engine's reads of a workspace record that take arguments, or
//! read its history or what its keeper holds: the since-readers, the file
//! references, where a container sits, and one document's entry and projection
//! (`READERS` in the TypeScript's `engine/readers.ts`).

use crate::engine_reads::{document_entry, number, ok, refused, seq, text, touched_entry};
use crate::hosted_reads::answer_hosted;
use crate::node_meta::{META_KEYS, NodeRead, WORKSPACE_TREE_KEY};
use crate::read_args::{ReadArgs, read_args, version_of};
use crate::record::{PlacedDocument, WorkspaceRecord};
use crate::removed::{NotRemoved, Removed, documents_removed_since};
use crate::touched::touched_documents;
use crate::walk::{walk, walk_naming_unreadable};
use whiteboard_crdt::{
    LoroDoc, NodeAt, NodeKeys, VersionVector, container_node, organisation_changed_since,
    peers_written_since, plain_value, project_node, tree,
};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName, ReadResponse};

/// The reads answered here.
pub(crate) const RECORD_READS: [QueryName; 7] = [
    QueryName::RemovedSince,
    QueryName::TouchedSince,
    QueryName::OrganisationChangedSince,
    QueryName::FileReferences,
    QueryName::ContainerPlace,
    QueryName::WorkspaceDocumentEntry,
    QueryName::WorkspaceDocumentProjection,
];

/// The node-map keys that say which document a node is and where it sits.
const PLACEMENT_KEYS: [&str; 3] = ["documentId", "segment", "kind"];

/// What a read refuses an argument it needs and lacks with.
const MISSING_ARGUMENT: &str = "TypeError";

fn map(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn removed_entry(removed: Removed) -> Value {
    let mut entries =
        vec![("documentId", text(&removed.document_id)), ("path", text(&removed.path))];
    if let Some(name) = &removed.name {
        entries.push(("name", text(name)));
    }
    if !removed.folder_names.is_empty() {
        let rows = removed
            .folder_names
            .iter()
            .map(|(path, name)| map(vec![("path", text(path)), ("name", text(name))]));
        entries.push(("folderNames", Value::Seq(rows.collect())));
    }
    entries.push(("bytes", map(vec![("$loroState", removed.state)])));
    map(entries)
}

/// The texts an `{ ok: [...] }` answer holds; `None` for a refusal.
fn ok_texts(answer: &Value) -> Option<Vec<String>> {
    let Value::Map(entries) = answer else { return None };
    let [(key, Value::Seq(items))] = entries.as_slice() else { return None };
    (key == "ok").then(|| {
        items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect()
    })
}

/// The images every live document names, sorted as JavaScript sorts strings,
/// and the nodes no reader reads; the keeper's trash bytes are asked of
/// nobody, so a trashed document names nothing. A document whose read is
/// refused refuses the whole read with its class.
fn file_references(doc: &LoroDoc) -> Option<ReadResponse> {
    let unjudged = tree(doc, WORKSPACE_TREE_KEY)
        .map(|held| walk_naming_unreadable(&held, held.roots(), "").1)
        .unwrap_or_default();
    let asked = Query { query: QueryName::ImageRefIds, args: None };
    let mut referenced: Vec<String> = Vec::new();
    for walked in walk(doc).0 {
        let NodeRead::Document(meta) = &walked.read else { continue };
        let answer = answer_hosted(doc, &asked, &meta.document_id, &[])?;
        let Some(ids) = ok_texts(&answer.value) else { return Some(answer) };
        referenced.extend(ids);
    }
    referenced.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    referenced.dedup();
    let unjudged = unjudged.iter().map(|node| {
        map(vec![("kind", text("unreadable-node")), ("treeId", text(&node.to_string()))])
    });
    Some(ok(map(vec![
        ("referenced", seq(referenced.iter(), |id| text(id))),
        ("unjudged", Value::Seq(unjudged.collect())),
    ])))
}

/// The document of the record `container` belongs to, its path, and a text
/// container's length; null for one the record lists no document for.
fn container_place(doc: &LoroDoc, container: &str) -> Value {
    let found = container_node(doc, container).and_then(|(node, length)| {
        let held = tree(doc, WORKSPACE_TREE_KEY)?;
        let Some(whiteboard_crdt::Entry::Value(Value::String(id))) = held.entry(node, "documentId")
        else {
            return None;
        };
        let placed = WorkspaceRecord::over(doc).placed_document(&id)?;
        let mut entries =
            vec![("documentId", text(&placed.meta.document_id)), ("path", text(&placed.path))];
        if let Some(length) = length {
            entries.push(("textLength", number(length as u64)));
        }
        Some(map(entries))
    });
    found.unwrap_or(Value::Null)
}

fn entry_value(placed: Option<PlacedDocument>) -> Value {
    placed.map_or(Value::Null, |placed| document_entry(&(placed, false)))
}

/// The document named by its id or by its path, one of them.
fn document_entry_read(doc: &LoroDoc, args: &ReadArgs) -> ReadResponse {
    let record = WorkspaceRecord::over(doc);
    match (&args.document_id, &args.path) {
        (Some(id), None) => ok(entry_value(record.placed_document(id))),
        (None, Some(path)) => ok(entry_value(record.placed_document_at(path))),
        _ => refused(MISSING_ARGUMENT),
    }
}

/// The document `document_id` names as a document of its own: its state, and
/// what its content, size and digest read as. `None` for a state holding
/// bytes, or a read of it this crate leaves to the caller.
fn projection(doc: &LoroDoc, document_id: &str) -> Option<ReadResponse> {
    let walked = walk(doc).0;
    let found = walked.iter().find(
        |each| matches!(&each.read, NodeRead::Document(meta) if meta.document_id == document_id),
    );
    let Some(found) = found else { return Some(ok(Value::Null)) };
    let projected = project_node(NodeAt { doc, tree: WORKSPACE_TREE_KEY, node: found.id }).ok()?;
    let read = |query| answer_content(&projected, query);
    Some(ok(map(vec![
        ("value", plain_value(&projected)?),
        ("documentContent", read(QueryName::DocumentContent)?),
        ("stateSize", read(QueryName::StateSize)?),
        ("contentDigest", read(QueryName::ContentDigest)?),
    ])))
}

fn answer_content(doc: &LoroDoc, query: QueryName) -> Option<Value> {
    let asked = Query { query, args: None };
    whiteboard_crdt::answer_content_query(doc, &asked).map(|answer| answer.value)
}

fn since_read(doc: &LoroDoc, query: QueryName, since: &VersionVector) -> Option<ReadResponse> {
    Some(ok(match query {
        QueryName::TouchedSince => {
            let touched = touched_documents(doc, since);
            if touched.len() > 1 && peers_written_since(doc, since) > 1 {
                return None;
            }
            seq(touched.iter(), touched_entry)
        }
        QueryName::RemovedSince => match documents_removed_since(doc, since) {
            Ok(removed) => Value::Seq(removed.into_iter().map(removed_entry).collect()),
            Err(NotRemoved::Unreachable) => return Some(refused("string")),
            Err(NotRemoved::Unread) => return None,
        },
        _ => {
            let keys = NodeKeys { meta: &META_KEYS, placement: &PLACEMENT_KEYS };
            Value::Bool(organisation_changed_since(doc, WORKSPACE_TREE_KEY, since, &keys)?)
        }
    }))
}

/// Answers one of [`RECORD_READS`], `None` for arguments the TypeScript's
/// schema refuses and for an answer this crate leaves to the caller.
pub(crate) fn answer_record_read(doc: &LoroDoc, query: &Query) -> Option<ReadResponse> {
    let args = read_args(query.args.as_ref()).ok()?;
    match query.query {
        QueryName::FileReferences => file_references(doc),
        QueryName::ContainerPlace => Some(match &args.container {
            Some(container) => ok(container_place(doc, container)),
            None => refused(MISSING_ARGUMENT),
        }),
        QueryName::WorkspaceDocumentEntry => Some(document_entry_read(doc, &args)),
        QueryName::WorkspaceDocumentProjection => match &args.document_id {
            Some(id) => projection(doc, id),
            None => Some(refused(MISSING_ARGUMENT)),
        },
        name => since_read(doc, name, &version_of(&args.since)?),
    }
}
