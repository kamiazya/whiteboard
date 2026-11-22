//! The write half of the document index over a workspace record: each
//! operation judges what it is asked from the record as it stands, writes
//! through `tree_write` and says whether the keeper must save the record.
//!
//! The ids a write mints and the clock it stamps with are handed in, so a keeper
//! (and the oracle replay) decides them.

use crate::ceiling::{documents_in, refuse_new_documents, refuse_new_folders_at};
use crate::display_name::{Named, NamedKind, js_trim, sibling_display_name_taken};
use crate::document_path::is_self_or_descendant;
use crate::entry::{DocumentEntry, entry_of};
use crate::index_error::IndexError;
use crate::index_rules::{
    DisplayNameTaken, distinct_unnamed_path, refuse_moved_name, refuse_sibling_document_name,
    same_display_name,
};
use crate::move_collision::move_collision;
use crate::node_meta::NodeRead;
use crate::record::WorkspaceRecord;
use crate::tree_write::{
    NewDocument, create_document_at_path, move_node_to_path, prune_empty_folders,
    set_document_name, set_folder_name, set_pinned,
};
use crate::write_input::{
    check_create, require_folder_name, require_id, require_name, require_path,
};

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
    let document_id = mint();
    let document =
        NewDocument { document_id: &document_id, kind: input.kind, name: input.name, now_ms };
    let written = create_document_at_path(record.doc(), &path, &document)?;
    // Absent means a document already owns the path, and nothing was written. This
    // is local: another replica may be creating the same path right now.
    let created = record.document_by_id(&document_id).filter(|_| written).ok_or_else(|| {
        IndexError::PathTaken { workspace_id: input.workspace_id.to_owned(), path: path.clone() }
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
