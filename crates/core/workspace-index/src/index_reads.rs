//! The read half of the document index over a workspace record: the port's
//! ordering promise and the refusal it makes of a path two documents hold.

use crate::document_path::compare_document_paths;
use crate::entry::{DocumentEntry, EntryError, entry_of};
use crate::record::WorkspaceRecord;
use crate::trash::TrashRow;

/// Why a read answered nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError {
    /// Two documents hold the path: the caller names the winner by id, or
    /// renames one, rather than being handed whichever sibling tree order
    /// favours.
    PathContested,
    /// A stored timestamp no JavaScript `Date` holds.
    InvalidTime(EntryError),
}

impl From<EntryError> for ReadError {
    fn from(error: EntryError) -> Self {
        Self::InvalidTime(error)
    }
}

/// `listDocuments`: every document, in the port's path order.
pub fn list_documents(record: &WorkspaceRecord) -> Result<Vec<DocumentEntry>, ReadError> {
    let mut entries = record
        .documents()
        .iter()
        .map(entry_of)
        .collect::<Result<Vec<DocumentEntry>, EntryError>>()?;
    entries.sort_by(|left, right| compare_document_paths(&left.path, &right.path));
    Ok(entries)
}

/// `resolveDocument`: the document at `path`, `None` for none, refused for a
/// contested path.
pub fn resolve_document(
    record: &WorkspaceRecord,
    path: &str,
) -> Result<Option<DocumentEntry>, ReadError> {
    let mut at_path = record.documents().into_iter().filter(|found| found.path == path);
    let Some(found) = at_path.next() else { return Ok(None) };
    if at_path.next().is_some() {
        return Err(ReadError::PathContested);
    }
    Ok(Some(entry_of(&found)?))
}

/// `resolveDocumentById`: the first document in tree order with the id.
pub fn resolve_document_by_id(
    record: &WorkspaceRecord,
    document_id: &str,
) -> Result<Option<DocumentEntry>, EntryError> {
    record.document_by_id(document_id).map(|found| entry_of(&found)).transpose()
}

/// `listPinnedDocuments`: pin order, restricted to documents the tree still
/// holds, since a delete removes the node without touching the pinned list.
#[must_use]
pub fn list_pinned_documents(record: &WorkspaceRecord) -> Vec<String> {
    let live: std::collections::BTreeSet<String> = record
        .nodes()
        .into_iter()
        .filter_map(|walked| match walked.read {
            crate::node_meta::NodeRead::Document(meta) => Some(meta.document_id),
            crate::node_meta::NodeRead::Folder { .. } => None,
        })
        .collect();
    record.pinned().into_iter().filter(|id| live.contains(id)).collect()
}

/// `listFolderNames`: the named folders, in the port's path order.
#[must_use]
pub fn list_folder_names(record: &WorkspaceRecord) -> Vec<(String, String)> {
    let mut names = record.folder_names();
    names.sort_by(|left, right| compare_document_paths(&left.0, &right.0));
    names
}

/// `listTrash`: what the workspace could still bring back, newest first.
#[must_use]
pub fn list_trash(record: &WorkspaceRecord) -> Vec<TrashRow> {
    record.trash()
}

#[cfg(test)]
mod tests;
