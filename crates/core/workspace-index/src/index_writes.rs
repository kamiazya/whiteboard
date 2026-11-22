//! The write half of the document index over a workspace record: each
//! operation judges what it is asked from the record as it stands, writes
//! through `tree_write` and says whether the keeper must save the record.
//!
//! The ids a write mints and the clock it stamps with are handed in, so a keeper
//! (and the oracle replay) decides them.

use crate::ceiling::{
    documents_in, folders_in, folders_missing_for, refuse_new_documents, refuse_new_folders,
    refuse_new_folders_at,
};
use crate::display_name::{Named, NamedKind, js_trim, sibling_display_name_taken};
use crate::document_path::is_self_or_descendant;
use crate::entry::{DocumentEntry, entry_of, require_time};
use crate::index_error::IndexError;
use crate::index_rules::{
    BlobRef, DisplayNameTaken, TrashEntry, distinct_unnamed_path, is_named_by_another_row,
    refuse_moved_name, refuse_sibling_document_name, same_display_name,
};
use crate::move_collision::move_collision;
use crate::node_meta::NodeRead;
use crate::record::{PlacedDocument, WorkspaceRecord};
use crate::restore_judgement::{Placement, restorable_trash_documents};
use crate::subtree::{PlaceError, export_subtree_at, import_subtree};
use crate::trash::TrashRow;
use crate::tree_write::{
    NewDocument, create_document_at_path, delete_node_at_path, forget_trash_entry,
    move_node_to_path, prune_empty_folders, reapply_folder_names, record_trash_entry,
    set_document_name, set_folder_name, set_pinned,
};
use crate::write_input::{
    check_create, require_folder_name, require_id, require_name, require_path,
};
use whiteboard_model::Value;

/// What a write answered, and whether the keeper must save the record.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome<T> {
    pub value: T,
    pub saved: bool,
}

impl<T> Outcome<T> {
    fn saved(value: T) -> Self {
        Self { value, saved: true }
    }

    fn unchanged(value: T) -> Self {
        Self { value, saved: false }
    }
}

/// `createDocument`'s input.
pub struct CreateDocument<'a> {
    pub workspace_id: &'a str,
    pub path: &'a str,
    pub kind: &'a str,
    pub name: Option<&'a str>,
}

/// `createDocument`: a new document at the path (an unnamed one at an address
/// that reads distinctly from its siblings), under the id `mint` supplies.
pub fn create_document(
    record: &WorkspaceRecord,
    input: &CreateDocument<'_>,
    mint: &mut dyn FnMut() -> String,
    now_ms: f64,
) -> Result<Outcome<DocumentEntry>, IndexError> {
    check_create(input.workspace_id, input.path, input.kind, input.name)?;
    let nodes = record.index_nodes();
    refuse_new_documents(documents_in(&nodes), 1)?;
    refuse_new_folders_at(&nodes, input.path)?;
    if let Some(name) = input.name {
        refuse_sibling_document_name(&nodes, input.path, name, None)?;
    }
    let owned =
        nodes.iter().any(|node| node.kind == NamedKind::Document && node.path == input.path);
    let path = if input.name.is_none() && !owned {
        distinct_unnamed_path(&nodes, input.path)
    } else {
        input.path.to_owned()
    };
    require_time(now_ms)?;
    let document_id = mint();
    let document =
        NewDocument { document_id: &document_id, kind: input.kind, name: input.name, now_ms };
    create_document_at_path(record.doc(), &path, &document)?;
    created_entry(record, input.workspace_id, &document_id, &path)
}

/// The entry of the document a write just created, answered as a resolve would.
/// Absent means a document already owned the path and nothing was written. That
/// is a local check: another replica may be creating the same path right now.
pub(crate) fn created_entry(
    record: &WorkspaceRecord,
    workspace_id: &str,
    document_id: &str,
    path: &str,
) -> Result<Outcome<DocumentEntry>, IndexError> {
    let created = record.document_by_id(document_id).ok_or_else(|| IndexError::PathTaken {
        workspace_id: workspace_id.to_owned(),
        path: path.to_owned(),
    })?;
    Ok(Outcome::saved(entry_of(&created)?))
}

/// `moveDocument`'s input.
pub struct MoveDocument<'a> {
    pub workspace_id: &'a str,
    pub from: &'a str,
    pub to: &'a str,
}

/// `moveDocument`: the node at `from` and everything below it, to `to`, and
/// the folders the move emptied pruned.
pub fn move_document(
    record: &WorkspaceRecord,
    input: &MoveDocument<'_>,
) -> Result<Outcome<()>, IndexError> {
    require_id(input.workspace_id)?;
    require_path(input.to)?;
    if input.from.is_empty() {
        return Err(IndexError::InvalidInput);
    }
    let nodes = record.index_nodes();
    let moving: Vec<_> = nodes
        .iter()
        .filter(|node| is_self_or_descendant(&node.path, input.from))
        .cloned()
        .collect();
    if moving.is_empty() {
        return Err(IndexError::DocumentNotFound {
            workspace_id: input.workspace_id.to_owned(),
            target: input.from.to_owned(),
        });
    }
    if is_self_or_descendant(input.to, input.from) {
        return Err(IndexError::MoveIntoSelf {
            from: input.from.to_owned(),
            to: input.to.to_owned(),
        });
    }
    if let Some(taken) = move_collision(&nodes, &moving, input.from, input.to) {
        return Err(IndexError::PathTaken {
            workspace_id: input.workspace_id.to_owned(),
            path: taken,
        });
    }
    refuse_new_folders_at(&nodes, input.to)?;
    refuse_moved_name(&nodes, &moving, input.from, input.to)?;
    move_node_to_path(record.doc(), input.from, input.to)?;
    prune_empty_folders(record.doc())?;
    Ok(Outcome::saved(()))
}

/// `setDocumentName`'s input; no name, or a blank one, clears it.
pub struct SetDocumentName<'a> {
    pub workspace_id: &'a str,
    pub document_id: &'a str,
    pub name: Option<&'a str>,
}

/// `setDocumentName`.
pub fn set_document_name_of(
    record: &WorkspaceRecord,
    input: &SetDocumentName<'_>,
) -> Result<Outcome<()>, IndexError> {
    require_id(input.workspace_id)?;
    require_id(input.document_id)?;
    if let Some(name) = input.name {
        require_name(name)?;
    }
    let Some(own) = record.document_node(input.document_id) else {
        return Err(IndexError::DocumentNotFound {
            workspace_id: input.workspace_id.to_owned(),
            target: input.document_id.to_owned(),
        });
    };
    let current = match &own.read {
        NodeRead::Document(meta) => meta.name.as_deref(),
        NodeRead::Folder { .. } => None,
    };
    let renamed = input.name.filter(|name| !js_trim(name).is_empty());
    if let Some(name) = renamed.filter(|name| !same_display_name(current, name)) {
        refuse_sibling_document_name(
            &record.index_nodes(),
            &own.path,
            name,
            Some(input.document_id),
        )?;
    }
    set_document_name(record.doc(), own.id, input.name)?;
    Ok(Outcome::saved(()))
}

/// `setDocumentPinned`'s input.
pub struct SetDocumentPinned<'a> {
    pub workspace_id: &'a str,
    pub document_id: &'a str,
    pub pinned: bool,
}

/// `setDocumentPinned`.
pub fn set_document_pinned(
    record: &WorkspaceRecord,
    input: &SetDocumentPinned<'_>,
) -> Result<Outcome<()>, IndexError> {
    if record.document_node(input.document_id).is_none() {
        return Err(IndexError::DocumentNotFound {
            workspace_id: input.workspace_id.to_owned(),
            target: input.document_id.to_owned(),
        });
    }
    require_id(input.document_id)?;
    set_pinned(record.doc(), input.document_id, input.pinned)?;
    Ok(Outcome::saved(()))
}

/// `setFolderName`'s input; no name clears it.
pub struct SetFolderName<'a> {
    pub workspace_id: &'a str,
    pub path: &'a str,
    pub name: Option<&'a str>,
}

/// `setFolderName`: refused for a duplicate this keeper can see; siblings that
/// merged in under one name stay as they arrived.
pub fn set_folder_name_of(
    record: &WorkspaceRecord,
    input: &SetFolderName<'_>,
) -> Result<Outcome<()>, IndexError> {
    require_id(input.workspace_id)?;
    require_path(input.path)?;
    if let Some(name) = input.name {
        require_folder_name(name)?;
    }
    let nodes = record.index_nodes();
    let at_path: Vec<_> = nodes
        .iter()
        .filter(|node| node.kind == NamedKind::Folder && node.path == input.path)
        .collect();
    if at_path.is_empty() {
        return Err(IndexError::DocumentNotFound {
            workspace_id: input.workspace_id.to_owned(),
            target: input.path.to_owned(),
        });
    }
    let current = at_path.iter().find_map(|node| node.name.as_deref());
    if let Some(name) = input.name.filter(|name| !same_display_name(current, name)) {
        let others: Vec<Named<'_>> = nodes
            .iter()
            .filter(|node| node.kind == NamedKind::Folder && node.path != input.path)
            .map(|node| Named { path: &node.path, name: node.name.as_deref() })
            .collect();
        if let Some(display_name) =
            sibling_display_name_taken(NamedKind::Folder, &others, input.path, name)
        {
            return Err(DisplayNameTaken {
                kind: NamedKind::Folder,
                path: input.path.to_owned(),
                display_name,
            }
            .into());
        }
    }
    set_folder_name(record.doc(), input.path, input.name)?;
    Ok(Outcome::saved(()))
}

/// Where a deleted document's bytes are kept, by what they hold: the keeper's
/// content-addressed store, handed in so the index never learns where it is.
pub trait TrashBlobs {
    /// Stores `bytes` and answers the address they are kept at.
    fn put(&mut self, bytes: Vec<u8>) -> BlobRef;
    /// The bytes kept at `blob`, or `None` when nothing is.
    fn get(&self, blob: &BlobRef) -> Option<Vec<u8>>;
    /// Lets go of the bytes kept at `blob`.
    fn delete(&mut self, blob: &BlobRef);
}

/// `deleteDocument`'s input.
pub struct DeleteDocument<'a> {
    pub workspace_id: &'a str,
    pub path: &'a str,
}

/// The most folder names one trash row keeps — the nearest, when more were named.
const TRASH_FOLDER_NAMES_MAX: usize = 256;

/// The named folders above `path` among `named`, shallowest first, as a trash
/// row keeps them so a restore can show them again.
fn named_folders_above(named: &[(String, String)], path: &str) -> Vec<(String, String)> {
    let segments: Vec<&str> = path.split('/').collect();
    let mut above: Vec<(String, String)> = (1..segments.len())
        .filter_map(|depth| {
            let folder = segments.get(..depth)?.join("/");
            named.iter().find(|(held, _)| *held == folder).cloned()
        })
        .collect();
    above.drain(..above.len().saturating_sub(TRASH_FOLDER_NAMES_MAX));
    above
}

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

/// The trash row a delete records, as the map stores it.
fn trash_row_value(
    document: (&str, Option<&str>),
    path: &str,
    folder_names: &[(String, String)],
    blob: &BlobRef,
    deleted_at: f64,
) -> Value {
    let mut entries = vec![
        ("documentId".to_owned(), text(document.0)),
        ("path".to_owned(), text(path)),
        ("deletedAt".to_owned(), Value::Number(deleted_at)),
        (
            "blob".to_owned(),
            Value::Map(vec![
                ("algorithm".to_owned(), text(&blob.algorithm)),
                ("digestHex".to_owned(), text(&blob.digest_hex)),
            ]),
        ),
    ];
    if let Some(name) = document.1 {
        entries.push(("name".to_owned(), text(name)));
    }
    if !folder_names.is_empty() {
        let rows = folder_names
            .iter()
            .map(|(path, name)| {
                Value::Map(vec![("path".to_owned(), text(path)), ("name".to_owned(), text(name))])
            })
            .collect();
        entries.push(("folderNames".to_owned(), Value::Seq(rows)));
    }
    Value::Map(entries)
}

/// Stores a document's bytes and records the trash row naming them; the delete
/// follows only once both stand.
fn evacuate(
    record: &WorkspaceRecord,
    document: (&str, Option<&str>),
    path: &str,
    blobs: &mut dyn TrashBlobs,
    now_ms: f64,
) -> Result<(), IndexError> {
    let Some(bytes) = export_subtree_at(record, path)? else { return Ok(()) };
    let blob = blobs.put(bytes);
    let folder_names = named_folders_above(&record.folder_names(), path);
    let row = trash_row_value(document, path, &folder_names, &blob, now_ms);
    record_trash_entry(record.doc(), document.0, &row)?;
    Ok(())
}

/// `deleteDocument`: the node at the path leaves the tree, a document after
/// its bytes are stored and its row recorded, and the folders it emptied go
/// with it. A path nothing holds is already gone.
pub fn delete_document(
    record: &WorkspaceRecord,
    input: &DeleteDocument<'_>,
    blobs: &mut dyn TrashBlobs,
    now_ms: f64,
) -> Result<Outcome<()>, IndexError> {
    let nodes = record.index_nodes();
    let Some(target) = nodes.iter().find(|node| node.path == input.path) else {
        return Ok(Outcome::unchanged(()));
    };
    // Every document can hold children, and only the NAMED path is evacuated,
    // so a cascade would destroy the descendants with no trash row to bring
    // them back: the caller names what it is destroying.
    let below = nodes
        .iter()
        .find(|node| node.path != input.path && is_self_or_descendant(&node.path, input.path));
    if let Some(descendant) = below {
        return Err(IndexError::HasDescendants {
            path: input.path.to_owned(),
            detail: format!("Delete \"{}\" and any others below it first.", descendant.path),
        });
    }
    // Evacuate BEFORE removing: a deleted node cannot be moved back and a shallow
    // snapshot drops its content, so nothing live can serve as the copy afterwards.
    if let Some(document_id) = &target.document_id {
        evacuate(record, (document_id, target.name.as_deref()), input.path, blobs, now_ms)?;
    }
    delete_node_at_path(record.doc(), input.path)?;
    prune_empty_folders(record.doc())?;
    Ok(Outcome::saved(()))
}

fn trash_entry(row: &TrashRow) -> TrashEntry {
    TrashEntry {
        document_id: row.document_id.clone(),
        blob: BlobRef { algorithm: row.algorithm.clone(), digest_hex: row.digest_hex.clone() },
    }
}

/// The bytes of a trash row to let go of, unless another row names the same ones: a
/// blob is content-addressed, so one copy serves every row that names it.
fn blob_to_release(rows: &[TrashRow], row: &TrashRow) -> Option<BlobRef> {
    let entries: Vec<TrashEntry> = rows.iter().map(trash_entry).collect();
    let entry = trash_entry(row);
    (!is_named_by_another_row(&entries, &entry)).then_some(entry.blob)
}

/// `purgeTrashEntry`'s input.
pub struct PurgeTrashEntry<'a> {
    pub workspace_id: &'a str,
    pub document_id: &'a str,
}

/// `purgeTrashEntry`: destroys a trashed document for good. The bytes go before
/// the row, so a failure part-way leaves the row standing and a second purge
/// finishes the job. `false`, with nothing written, when no row names it.
pub fn purge_trash_entry(
    record: &WorkspaceRecord,
    input: &PurgeTrashEntry<'_>,
    blobs: &mut dyn TrashBlobs,
) -> Result<Outcome<bool>, IndexError> {
    let rows = record.trash();
    let Some(row) = rows.iter().find(|row| row.document_id == input.document_id) else {
        return Ok(Outcome::unchanged(false));
    };
    if let Some(blob) = blob_to_release(&rows, row) {
        blobs.delete(&blob);
    }
    forget_trash_entry(record.doc(), &row.document_id)?;
    Ok(Outcome::saved(true))
}

/// `restoreDocument`'s input.
pub struct RestoreDocument<'a> {
    pub workspace_id: &'a str,
    pub document_id: &'a str,
}

/// What a restore places: the bytes, the folder they go under and what they hold.
struct Restoring {
    bytes: Vec<u8>,
    parent: Option<String>,
    placement: Placement,
}

/// What a restore of a trash row stops at, before anything is placed: `None`
/// for a row, a copy or bytes that cannot be brought back.
fn restorable(
    record: &WorkspaceRecord,
    row: &TrashRow,
    blobs: &dyn TrashBlobs,
) -> Result<Option<Restoring>, IndexError> {
    // A second node under one id lists twice and contests its path; the row
    // stays, since the trashed copy may hold what the live one lacks.
    if record.document_node(&row.document_id).is_some() {
        return Ok(None);
    }
    let blob = BlobRef { algorithm: row.algorithm.clone(), digest_hex: row.digest_hex.clone() };
    // The row survives a missing blob: it is the only record the document existed.
    let Some(bytes) = blobs.get(&blob) else { return Ok(None) };
    let parent = row.path.rsplit_once('/').map(|(above, _)| above.to_owned());
    let judged = restorable_trash_documents(&bytes, &row.document_id, parent.as_deref())
        .map_err(IndexError::UnreadableTrashBytes)?;
    Ok(judged.map(|placement| Restoring { bytes, parent, placement }))
}

/// What a restore answers: the document it placed, and the bytes the keeper lets go
/// of once it has saved the record. After the save and not before: a failure
/// between the two would leave a row naming bytes that are gone, where the other
/// order strands a blob a later purge cannot reach, which costs space and not the
/// document.
#[derive(Debug, Clone, PartialEq)]
pub struct Restored {
    pub placed: Option<PlacedDocument>,
    pub release: Option<BlobRef>,
}

impl Restored {
    fn nothing() -> Outcome<Self> {
        Outcome::unchanged(Self { placed: None, release: None })
    }
}

/// `restoreDocument`: brings a deleted document back under the id it had, as a
/// copy (loro will not revive a deleted node) so a share link still resolves.
/// Nothing placed, and nothing written, when the row, the bytes or the room is not there.
pub fn restore_document(
    record: &WorkspaceRecord,
    input: &RestoreDocument<'_>,
    blobs: &dyn TrashBlobs,
) -> Result<Outcome<Restored>, IndexError> {
    let rows = record.trash();
    let Some(row) = rows.iter().find(|row| row.document_id == input.document_id) else {
        return Ok(Restored::nothing());
    };
    let Some(Restoring { bytes, parent, placement }) = restorable(record, row, blobs)? else {
        return Ok(Restored::nothing());
    };
    // A refusal rather than `None`: the row is fine and restorable once the workspace has room.
    let nodes = record.index_nodes();
    refuse_new_documents(documents_in(&nodes), placement.documents)?;
    refuse_new_folders(
        folders_in(&nodes),
        placement.folders.saturating_add(folders_missing_for(&nodes, &row.path)),
    )?;
    let placed = match import_subtree(record, &bytes, parent.as_deref()) {
        Ok(Some(document_id)) => document_id,
        Ok(None) => return Ok(Restored::nothing()),
        Err(PlaceError::Unreadable(error)) => return Err(IndexError::UnreadableTrashBytes(error)),
        Err(PlaceError::Refused(error)) => return Err(error.into()),
    };
    if let Some(names) = &row.folder_names {
        reapply_folder_names(record.doc(), names)?;
    }
    forget_trash_entry(record.doc(), &row.document_id)?;
    let release = blob_to_release(&record.trash(), row);
    Ok(Outcome::saved(Restored { placed: record.placed_document(&placed), release }))
}

#[cfg(test)]
mod tests;
