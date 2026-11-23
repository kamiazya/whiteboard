//! A document leaving a workspace record as bytes, and coming back: the
//! subtree at a path exported as a document of its own, and an exported one
//! placed again under a folder.

use crate::node_meta::{NodeRead, WORKSPACE_TREE_KEY, read_node};
use crate::record::WorkspaceRecord;
use crate::tree_write::{attach_content_containers, ensure_folder_path};
use whiteboard_crdt::{
    ContainerKind, ImportError, LoroDoc, NodeAt, NodeId, SubtreeCopy, WriteError, commit,
    copy_subtree, export_subtree, import_bytes, tree,
};

/// The content keys a document node declares, and what each must hold to be
/// copied: a key holding something else is unreadable content, left behind
/// and attached fresh.
const CONTENT_KINDS: [(&str, ContainerKind); 13] = [
    ("nodes", ContainerKind::Map),
    ("edges", ContainerKind::Map),
    ("lines", ContainerKind::Map),
    ("canvas", ContainerKind::Map),
    ("threads", ContainerKind::Map),
    ("proposals", ContainerKind::Map),
    ("facets", ContainerKind::Map),
    ("nodeLocks", ContainerKind::Map),
    ("edgeLocks", ContainerKind::Map),
    ("core", ContainerKind::Map),
    ("trust", ContainerKind::Map),
    ("document", ContainerKind::Map),
    ("body", ContainerKind::Text),
];

/// A key that is not a declared content key travels as it is; a declared one
/// travels only as the container it is declared to be.
fn travels(key: &str, held: Option<ContainerKind>) -> bool {
    CONTENT_KINDS
        .iter()
        .find(|(declared, _)| *declared == key)
        .is_none_or(|(_, kind)| held == Some(*kind))
}

/// A copied node that records a document is given every content container it
/// may lack, so a document written before they were attached at creation holds them now.
fn finish(from: NodeAt<'_>, to: NodeAt<'_>) -> Result<(), WriteError> {
    if from.entry("documentId").is_some() {
        attach_content_containers(to.doc, to.node)?;
    }
    Ok(())
}

const COPY: SubtreeCopy<'static> = SubtreeCopy { wanted: &travels, finish: &finish };

/// The subtree at `path` as a snapshot of a document of its own: a value copy,
/// with none of the history that produced it. `None` when nothing is there.
pub fn export_subtree_at(
    record: &WorkspaceRecord,
    path: &str,
) -> Result<Option<Vec<u8>>, WriteError> {
    let Some(found) = record.node_at(path) else { return Ok(None) };
    let from = NodeAt { doc: record.doc(), tree: WORKSPACE_TREE_KEY, node: found.id };
    export_subtree(from, &COPY).map(Some)
}

/// The subtree rooted at `node` exported as [`export_subtree_at`] exports
/// one, for a caller holding the node from a walk it already paid for. `None`
/// when the tree does not hold the node or a delete took it.
pub(crate) fn export_node(doc: &LoroDoc, node: NodeId) -> Result<Option<Vec<u8>>, WriteError> {
    if !tree(doc, WORKSPACE_TREE_KEY).is_some_and(|held| held.is_live(node)) {
        return Ok(None);
    }
    let from = NodeAt { doc, tree: WORKSPACE_TREE_KEY, node };
    export_subtree(from, &COPY).map(Some)
}

/// Why an exported subtree was not placed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlaceError {
    /// The bytes are not a document loro reads.
    Unreadable(ImportError),
    /// Loro refused an operation the placement needed.
    Refused(WriteError),
}

impl From<WriteError> for PlaceError {
    fn from(error: WriteError) -> Self {
        Self::Refused(error)
    }
}

/// Places an exported subtree under `parent_path` (the root when absent),
/// keeping the document id it was exported with; its tree ids are new, since
/// loro will not revive a deleted node. The id of the document it placed, or
/// `None`, with nothing written, when the bytes hold no document.
pub fn import_subtree(
    record: &WorkspaceRecord,
    bytes: &[u8],
    parent_path: Option<&str>,
) -> Result<Option<String>, PlaceError> {
    let source = import_bytes(bytes).map_err(PlaceError::Unreadable)?;
    let Some(held) = tree(&source, WORKSPACE_TREE_KEY) else { return Ok(None) };
    let Some(first) = held.roots().into_iter().next() else { return Ok(None) };
    let Some(NodeRead::Document(meta)) = read_node(&held, first) else { return Ok(None) };
    let parent = match parent_path {
        Some(path) => ensure_folder_path(record.doc(), &path.split('/').collect::<Vec<_>>())?,
        None => None,
    };
    let from = NodeAt { doc: &source, tree: WORKSPACE_TREE_KEY, node: first };
    copy_subtree(from, (record.doc(), WORKSPACE_TREE_KEY), parent, &COPY)?;
    commit(record.doc());
    Ok(Some(meta.document_id))
}

#[cfg(test)]
mod tests;
