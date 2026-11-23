//! Which documents the operations after a version wrote to: what the engine
//! answers a write as having changed (`documentsTouchedSince` in the
//! TypeScript's `touched-documents.ts`). Read off the operations, so the cost
//! follows the update rather than the record.

use crate::node_meta::WORKSPACE_TREE_KEY;
use whiteboard_crdt::{Entry, LoroDoc, NodeId, Tree, VersionVector, node_writes_since, tree};
use whiteboard_model::Value;

/// A string held at `key` of the node's map, read as the TypeScript reads it:
/// anything else, a container included, is none.
fn held_text(tree: &Tree, node: NodeId, key: &str) -> Option<String> {
    match tree.entry(node, key)? {
        Entry::Value(Value::String(text)) => Some(text),
        _ => None,
    }
}

/// A document the operations after a version wrote to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Touched {
    pub document_id: String,
    /// The tree node holding it.
    pub node: NodeId,
    /// Derived from ancestry as of now, as every listing derives it.
    pub path: String,
    /// Whether an operation landed inside one of the document's containers,
    /// rather than only on its node's own map: a rename is a write to the
    /// node, and is not an edit of the document.
    pub content_written: bool,
}

/// `node`'s path: its segment under every ancestor's, `None` when it or any
/// node above it holds no string segment.
fn path_of(tree: &Tree, node: NodeId) -> Option<String> {
    let mut segments = Vec::new();
    let mut at = Some(node);
    while let Some(node) = at {
        segments.push(held_text(tree, node, "segment")?);
        at = tree.parent(node);
    }
    segments.reverse();
    Some(segments.join("/"))
}

/// Every document an operation after `since` wrote to, in the order the
/// operations reach them: a node holding a `documentId` with a path. A folder
/// and a node below an unreadable segment are not documents a write touched,
/// nor is a node a delete took, with itself or an ancestor, which
/// `node_writes_since` already leaves out: no path reaches its containers.
#[must_use]
pub fn touched_documents(doc: &LoroDoc, since: &VersionVector) -> Vec<Touched> {
    let Some(held) = tree(doc, WORKSPACE_TREE_KEY) else { return Vec::new() };
    node_writes_since(doc, WORKSPACE_TREE_KEY, since)
        .into_iter()
        .filter_map(|(node, content_written)| {
            let path = path_of(&held, node)?;
            let document_id = held_text(&held, node, "documentId")?;
            Some(Touched { document_id, node, path, content_written })
        })
        .collect()
}

/// The id of every document an operation after `since` wrote to
/// ([`touched_documents`]).
#[must_use]
pub fn documents_touched_since(doc: &LoroDoc, since: &VersionVector) -> Vec<String> {
    touched_documents(doc, since).into_iter().map(|touched| touched.document_id).collect()
}

#[cfg(test)]
mod tests;
