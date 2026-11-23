//! Which documents the operations after a version wrote to: what the engine
//! answers a write as having changed (`documentsTouchedSince` in the
//! TypeScript's `touched-documents.ts`). Read off the operations, so the cost
//! follows the update rather than the record.

use crate::node_meta::WORKSPACE_TREE_KEY;
use whiteboard_crdt::{Entry, LoroDoc, NodeId, Tree, VersionVector, nodes_written_since, tree};
use whiteboard_model::Value;

/// A string held at `key` of the node's map, read as the TypeScript reads it:
/// anything else, a container included, is none.
fn held_text(tree: &Tree, node: NodeId, key: &str) -> Option<String> {
    match tree.entry(node, key)? {
        Entry::Value(Value::String(text)) => Some(text),
        _ => None,
    }
}

/// Whether `node` has a path: it and every node above it hold a segment.
fn placed(tree: &Tree, node: NodeId) -> bool {
    let mut at = Some(node);
    while let Some(node) = at {
        if held_text(tree, node, "segment").is_none() {
            return false;
        }
        at = tree.parent(node);
    }
    true
}

/// The id of every document an operation after `since` wrote to, in the order
/// the operations reach them: a live node holding a `documentId` with a path.
/// A folder, a node a delete took and a node below an unreadable segment are
/// not documents a write touched.
#[must_use]
pub fn documents_touched_since(doc: &LoroDoc, since: &VersionVector) -> Vec<String> {
    let Some(held) = tree(doc, WORKSPACE_TREE_KEY) else { return Vec::new() };
    nodes_written_since(doc, WORKSPACE_TREE_KEY, since)
        .into_iter()
        .filter(|&node| held.is_live(node) && placed(&held, node))
        .filter_map(|node| held_text(&held, node, "documentId"))
        .collect()
}

#[cfg(test)]
mod tests;
