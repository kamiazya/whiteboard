//! Whether a trashed document's bytes may be put back into a workspace record.
//!
//! A trash row and the bytes it names both arrive from outside the keeper: the
//! row is synced data any writer of the record can rewrite, and a promotion
//! carries bytes the other keeper chose. A restore places what they say into
//! the live record without passing the sync-write checks, so this judges these
//! of their bounds (not all of them; see the ponytail below): the path grammar on every node it places (folders
//! included), the name bound and readable node meta. Judged on the bytes
//! alone, before anything touches the live record, so a refusal leaves the
//! workspace as it was.
//!
//! ponytail: the text limits the engine judges an import against (a body or
//! node text past its bound) are not judged here; they belong with the sync
//! judge, which is not ported. Bytes past them answer as placeable.

use crate::document_path::is_document_path;
use crate::node_meta::{NodeRead, WORKSPACE_TREE_KEY, read_node};
use crate::walk::{Walked, walk_under};
use whiteboard_crdt::{ImportError, import_bytes, tree_roots};
use whiteboard_det::utf16;

/// `DOCUMENT_NAME_MAX_LENGTH`, in UTF-16 units.
const DOCUMENT_NAME_MAX_LENGTH: usize = 200;

/// What the bytes would place: the documents, and the folders below the
/// restored document's own path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub documents: usize,
    pub folders: usize,
}

/// How many documents and folders the bytes would place for `document_id`
/// under `parent_path`, or `None` when they may not be placed at all. `Err`
/// when the bytes are not a record loro reads.
pub fn restorable_trash_documents(
    bytes: &[u8],
    document_id: &str,
    parent_path: Option<&str>,
) -> Result<Option<Placement>, ImportError> {
    let doc = import_bytes(bytes)?;
    let Some(root) = tree_roots(&doc, WORKSPACE_TREE_KEY).into_iter().next() else {
        return Ok(None);
    };
    // The bytes' root must be the row's document, so a row can only bring
    // back the document it is for.
    let Some(NodeRead::Document(meta)) = read_node(&doc, root) else { return Ok(None) };
    if meta.document_id != document_id {
        return Ok(None);
    }
    let prefix = parent_path.unwrap_or("");
    let (subtree, unreadable) = walk_under(&doc, vec![root], prefix);
    if unreadable > 0 {
        return Ok(None);
    }
    // The folders the live record would make for `parent_path` are prefixes of
    // the root's own path, so the grammar judges them with it, and they are not
    // part of what the bytes place.
    Ok(placeable_nodes(&subtree))
}

/// The documents and the folders that `nodes` hold, or `None`
/// when any node sits at a path the grammar refuses or a document carries a
/// name past the bound.
fn placeable_nodes(nodes: &[Walked]) -> Option<Placement> {
    let mut placement = Placement { documents: 0, folders: 0 };
    for Walked { path, read, .. } in nodes {
        if !is_document_path(path) {
            return None;
        }
        match read {
            NodeRead::Document(meta) => {
                if meta.name.as_deref().is_some_and(|n| utf16::len(n) > DOCUMENT_NAME_MAX_LENGTH) {
                    return None;
                }
                placement.documents = placement.documents.saturating_add(1);
            }
            NodeRead::Folder { .. } => {
                placement.folders = placement.folders.saturating_add(1);
            }
        }
    }
    Some(placement)
}

#[cfg(test)]
mod tests;
