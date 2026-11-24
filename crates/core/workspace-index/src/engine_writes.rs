//! The document engine's writers over a workspace record's tree, answered
//! beside `whiteboard-crdt`'s through [`MoreWriters`]: the record's rules live
//! here, and the crdt crate cannot depend on this one.
//!
//! Each writer follows its TypeScript in `workspace-tree.ts` and
//! `workspace-folder-name.ts` over the same `tree_write` calls the document
//! index writes through, so a write appends the operations the TypeScript's
//! appends. Every one opens the tree root first, as the TypeScript's `getTree`
//! does on every path that does not throw, so a write to a record that held no
//! tree leaves an empty root in its snapshot. The documents a batch touched
//! are [`documents_touched_since`]. `Date.now` is handed in.
//!
//! What a writer throws: `Error` for a document id that names none or a folder
//! name the model refuses; `ZodError` for a created document's meta the node
//! schema refuses; and a plain string, as npm loro-crdt throws, for a move the
//! tree refuses (a node under itself).

use crate::hosted_reads::is_safe_integer;
use crate::node_meta::WORKSPACE_TREE_KEY;
use crate::record::WorkspaceRecord;
use crate::touched::documents_touched_since;
use crate::tree_write::{
    NewDocument, create_document_at_path, delete_node_at_path, ensure_folder_path,
    move_node_to_path, set_document_name, set_folder_name, stamp_document,
};
use crate::write_input::folder_name_refused;
use whiteboard_crdt::{
    Fault, LoroDoc, MoreWriters, NodeId, Step, VersionVector, Written, commit, create_node,
    delete_node, move_node, open_tree, tree, write_batch_with,
};
use whiteboard_model::Value;
use whiteboard_model::checks::canonical_ulid;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};

/// The writers [`WorkspaceWriters`] answers.
pub const WORKSPACE_WRITERS: &[WriterName] = &[
    WriterName::CreateWorkspaceDocumentAtPath,
    WriterName::CreateWorkspaceDocument,
    WriterName::EnsureFolderPath,
    WriterName::MoveWorkspaceDocument,
    WriterName::MoveWorkspaceNodeToPath,
    WriterName::SetWorkspaceDocumentName,
    WriterName::SetWorkspaceFolderName,
    WriterName::DeleteWorkspaceDocument,
    WriterName::DeleteWorkspaceNode,
    WriterName::DeleteWorkspaceNodeAtPath,
    WriterName::WriteWorkspaceDocumentContent,
    WriterName::WriteDocumentContentAndName,
    WriterName::SeedNameFromTitle,
    WriterName::SeedNamesFromTitles,
    WriterName::StampEditedDocuments,
    WriterName::SetWorkspaceLastCompactedAt,
    WriterName::SetWorkspacePinned,
    WriterName::RecordTrashEntry,
    WriterName::UpdateWorkspaceDocumentMeta,
    WriterName::PruneEmptyFolders,
    WriterName::DuplicateWorkspaceDocument,
    WriterName::ForgetTrashEntry,
    WriterName::ReapplyFolderNames,
];

mod content;
mod record;

const ERROR: Fault = Fault::Thrown("Error");
const ERROR_TYPE: Fault = Fault::Thrown("TypeError");
const ZOD_ERROR: Fault = Fault::Thrown("ZodError");

/// A refusal of the tree's, which npm loro-crdt throws as a plain string.
const LORO: Fault = Fault::Thrown("string");

pub(super) fn field<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    let Value::Map(entries) = args else { return None };
    entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// The string argument `key`, which the writer's types require.
pub(super) fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, Fault> {
    optional_text(args, key)?.ok_or(Fault::Declined)
}

fn optional_text<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, Fault> {
    match field(args, key) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(Fault::Declined),
    }
}

pub(super) fn optional_number(args: &Value, key: &str) -> Result<Option<f64>, Fault> {
    match field(args, key) {
        None => Ok(None),
        Some(Value::Number(n)) => Ok(Some(*n)),
        Some(_) => Err(Fault::Declined),
    }
}

/// A created document's meta as `workspaceNodeMetaSchema` parses it, the
/// stamps defaulted to `now_ms`.
fn new_document(args: &Value, now_ms: f64) -> Result<NewDocument<'_>, Fault> {
    let (created, updated) =
        (optional_number(args, "createdAt")?, optional_number(args, "updatedAt")?);
    Ok(NewDocument {
        document_id: text(args, "documentId")?,
        kind: text(args, "kind")?,
        name: optional_text(args, "name")?,
        created_at: created.unwrap_or(now_ms),
        updated_at: updated.or(created).unwrap_or(now_ms),
    })
}

/// Whether `workspaceNodeMetaSchema` accepts a created document's meta at its
/// own path part `segment`.
fn accepted(document: &NewDocument<'_>, segment: &str) -> bool {
    canonical_ulid(document.document_id)
        && !segment.is_empty()
        && matches!(document.kind, "spatial" | "markdown")
        && document.name.is_none_or(|name| !name.is_empty())
        && is_safe_integer(document.created_at)
        && is_safe_integer(document.updated_at)
}

/// `createWorkspaceDocumentAtPath`: whether it created. The meta is parsed
/// only once no document owns the path, after the folders above it are made;
/// a refusal then undoes them with the batch.
fn create_at(doc: &LoroDoc, path: &str, document: &NewDocument<'_>) -> Result<bool, Fault> {
    let own = path.rsplit('/').next().unwrap_or(path);
    let created = create_document_at_path(doc, path, document).map_err(|_| LORO)?;
    if created && !accepted(document, own) {
        return Err(ZOD_ERROR);
    }
    Ok(created)
}

/// The node of the document `id` names, first in tree order.
pub(super) fn document_node(doc: &LoroDoc, id: &str) -> Option<NodeId> {
    WorkspaceRecord::over(doc).document_node(id).map(|walked| walked.id)
}

fn create_at_path(doc: &LoroDoc, args: &Value, now_ms: f64) -> Step {
    let path = text(args, "path")?;
    create_at(doc, path, &new_document(args, now_ms)?).map(|_| ())
}

fn create(doc: &LoroDoc, args: &Value, now_ms: f64) -> Step {
    let segment = text(args, "segment")?;
    let document = new_document(args, now_ms)?;
    let parent_id = optional_text(args, "parentId")?;
    if !accepted(&document, segment) {
        return Err(ZOD_ERROR);
    }
    let parent = match parent_id {
        Some(id) => Some(document_node(doc, id).ok_or(ERROR)?),
        None => None,
    };
    let node = create_node(doc, WORKSPACE_TREE_KEY, parent).map_err(|_| LORO)?;
    stamp_document(doc, node, segment, &document, false).map_err(|_| LORO)
}

fn ensure(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let Some(Value::Seq(items)) = field(args, "segments") else { return Err(Fault::Declined) };
    let segments = items
        .iter()
        .map(|item| {
            if let Value::String(segment) = item {
                Ok(segment.as_str())
            } else {
                Err(Fault::Declined)
            }
        })
        .collect::<Result<Vec<&str>, Fault>>()?;
    ensure_folder_path(doc, &segments).map(|_| ()).map_err(|_| LORO)
}

fn move_document(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let node = document_node(doc, text(args, "documentId")?).ok_or(ERROR)?;
    let parent = match optional_text(args, "parentId")? {
        Some(id) => Some(document_node(doc, id).ok_or(ERROR)?),
        None => None,
    };
    move_node(doc, WORKSPACE_TREE_KEY, node, parent).map_err(|_| LORO)?;
    commit(doc);
    Ok(())
}

fn move_to_path(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    move_node_to_path(doc, text(args, "from")?, text(args, "to")?).map(|_| ()).map_err(|_| LORO)
}

fn name_document(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let node = document_node(doc, text(args, "documentId")?).ok_or(ERROR)?;
    set_document_name(doc, node, optional_text(args, "name")?).map_err(|_| LORO)
}

fn name_folder(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let (path, name) = (text(args, "path")?, optional_text(args, "name")?);
    if name.is_some_and(folder_name_refused) {
        return Err(ERROR);
    }
    set_folder_name(doc, path, name).map(|_| ()).map_err(|_| LORO)
}

fn delete_document(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    if let Some(node) = document_node(doc, text(args, "documentId")?) {
        delete_node(doc, WORKSPACE_TREE_KEY, node).map_err(|_| LORO)?;
        commit(doc);
    }
    Ok(())
}

/// A node a delete already took, with itself or an ancestor, is left be; text
/// naming no node names none the tree holds.
fn delete_by_id(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    let id = NodeId::parse(text(args, "id")?);
    let held = tree(doc, WORKSPACE_TREE_KEY);
    if let (Some(node), Some(held)) = (id, held)
        && held.is_live(node)
    {
        delete_node(doc, WORKSPACE_TREE_KEY, node).map_err(|_| LORO)?;
        commit(doc);
    }
    Ok(())
}

fn delete_at_path(doc: &LoroDoc, args: &Value, _: f64) -> Step {
    delete_node_at_path(doc, text(args, "path")?).map(|_| ()).map_err(|_| LORO)
}

type Writer = fn(&LoroDoc, &Value, f64) -> Step;

/// The writer of `op`, and whether its TypeScript opens the tree root, as every
/// `getTree` does: a writer of the planes beside the tree never asks for it.
fn writer_of(op: WriterName) -> Option<(Writer, bool)> {
    let beside: Writer = match op {
        WriterName::SetWorkspaceLastCompactedAt => record::last_compacted_at,
        WriterName::SetWorkspacePinned => record::pinned,
        WriterName::RecordTrashEntry => record::record_trash,
        WriterName::ForgetTrashEntry => record::forget_trash,
        _ => return tree_writer_of(op).map(|write| (write, true)),
    };
    Some((beside, false))
}

fn tree_writer_of(op: WriterName) -> Option<Writer> {
    Some(match op {
        WriterName::CreateWorkspaceDocumentAtPath => create_at_path,
        WriterName::CreateWorkspaceDocument => create,
        WriterName::EnsureFolderPath => ensure,
        WriterName::MoveWorkspaceDocument => move_document,
        WriterName::MoveWorkspaceNodeToPath => move_to_path,
        WriterName::SetWorkspaceDocumentName => name_document,
        WriterName::SetWorkspaceFolderName => name_folder,
        WriterName::DeleteWorkspaceDocument => delete_document,
        WriterName::DeleteWorkspaceNode => delete_by_id,
        WriterName::DeleteWorkspaceNodeAtPath => delete_at_path,
        WriterName::UpdateWorkspaceDocumentMeta => record::update_meta,
        WriterName::PruneEmptyFolders => record::prune,
        WriterName::ReapplyFolderNames => record::reapply_names,
        WriterName::WriteWorkspaceDocumentContent => content::write_content,
        WriterName::WriteDocumentContentAndName => content::write_content_and_name,
        WriterName::SeedNameFromTitle => content::seed_name,
        WriterName::SeedNamesFromTitles => content::seed_names,
        WriterName::StampEditedDocuments => content::stamp_edited,
        WriterName::DuplicateWorkspaceDocument => content::duplicate,
        _ => return None,
    })
}

/// The workspace writers, stamping what they create with `now_ms`.
pub struct WorkspaceWriters {
    pub now_ms: f64,
}

impl MoreWriters for WorkspaceWriters {
    fn apply(&self, doc: &LoroDoc, op: WriterName, args: &Value) -> Option<Step> {
        let (write, opens_tree) = writer_of(op)?;
        if opens_tree {
            open_tree(doc, WORKSPACE_TREE_KEY);
        }
        Some(write(doc, args, self.now_ms))
    }

    fn changed(&self, doc: &LoroDoc, from: &VersionVector) -> Vec<String> {
        documents_touched_since(doc, from)
    }
}

/// The engine's `write` over a workspace record: `whiteboard-crdt`'s writers and
/// the workspace writers in one batch, `now_ms` standing for `Date.now`. `None`
/// for what neither answers.
#[must_use]
pub fn write_workspace_batch(
    before: &[u8],
    peer: u64,
    batch: &[Write],
    judge: WriteJudge,
    now_ms: f64,
) -> Option<Written> {
    write_batch_with(before, peer, batch, judge, &WorkspaceWriters { now_ms })
}

#[cfg(test)]
mod tests;
