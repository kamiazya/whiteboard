//! How many documents and folders one workspace record may list.

use crate::index_error::IndexError;
use crate::index_rules::Node;
use crate::index_rules::NodeKind;
use std::collections::BTreeSet;

/// `WORKSPACE_MAX_DOCUMENTS`.
pub const WORKSPACE_MAX_DOCUMENTS: usize = 2000;
/// `WORKSPACE_MAX_FOLDERS`.
pub const WORKSPACE_MAX_FOLDERS: usize = 2 * WORKSPACE_MAX_DOCUMENTS;

/// Refuses a write that would leave the workspace listing more than
/// `WORKSPACE_MAX_DOCUMENTS`, and more than it listed before: a record already
/// past the bound still takes a write that adds none.
pub fn refuse_new_documents(held: usize, adding: usize) -> Result<(), IndexError> {
    let after = held.saturating_add(adding);
    if adding > 0 && after > WORKSPACE_MAX_DOCUMENTS {
        return Err(IndexError::TooManyDocuments { documents: after });
    }
    Ok(())
}

/// `refuse_new_documents` for folders.
pub fn refuse_new_folders(held: usize, adding: usize) -> Result<(), IndexError> {
    let after = held.saturating_add(adding);
    if adding > 0 && after > WORKSPACE_MAX_FOLDERS {
        return Err(IndexError::TooManyFolders { folders: after });
    }
    Ok(())
}

/// How many documents a workspace record's `nodes` hold.
#[must_use]
pub fn documents_in(nodes: &[Node]) -> usize {
    nodes.iter().filter(|node| node.kind == NodeKind::Document).count()
}

/// How many folders a workspace record's `nodes` hold.
#[must_use]
pub fn folders_in(nodes: &[Node]) -> usize {
    nodes.iter().filter(|node| node.kind == NodeKind::Folder).count()
}

/// How many folders placing something at `path` would create: one for each
/// ancestor no node holds yet, since an existing node of either kind is reused
/// as the parent.
#[must_use]
pub fn folders_missing_for(nodes: &[Node], path: &str) -> usize {
    let held: BTreeSet<&str> = nodes.iter().map(|node| node.path.as_str()).collect();
    let segments: Vec<&str> = path.split('/').collect();
    (1..segments.len())
        .filter(|depth| {
            segments.get(..*depth).is_some_and(|above| !held.contains(above.join("/").as_str()))
        })
        .count()
}

/// `refuse_new_folders` for one placement at `path` into a record holding `nodes`.
pub fn refuse_new_folders_at(nodes: &[Node], path: &str) -> Result<(), IndexError> {
    refuse_new_folders(folders_in(nodes), folders_missing_for(nodes, path))
}

#[cfg(test)]
mod tests;
