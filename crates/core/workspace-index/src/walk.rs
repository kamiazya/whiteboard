//! The tree walked into the nodes a listing reads, each with its path.

use crate::node_meta::{NodeRead, WORKSPACE_TREE_KEY, read_node};
use whiteboard_crdt::{LoroDoc, NodeId, tree_children, tree_roots};

/// A live node, its path derived from the segments above it.
#[derive(Debug, Clone, PartialEq)]
pub struct Walked {
    pub id: NodeId,
    pub read: NodeRead,
    pub path: String,
}

/// Every readable live node in tree order (depth-first pre-order), with its
/// derived path. A node whose meta cannot be read is skipped with everything
/// below it, because a path below it would need the segment it does not have;
/// `skipped` counts such nodes.
#[must_use]
pub fn walk(doc: &LoroDoc) -> (Vec<Walked>, usize) {
    walk_under(doc, tree_roots(doc, WORKSPACE_TREE_KEY), "")
}

/// The same walk over the subtrees of `starts`, each path below `prefix`
/// (empty for the workspace root).
#[must_use]
pub fn walk_under(doc: &LoroDoc, starts: Vec<NodeId>, prefix: &str) -> (Vec<Walked>, usize) {
    let mut out = Vec::new();
    let mut skipped = 0_usize;
    let mut stack: Vec<(NodeId, String)> =
        starts.into_iter().rev().map(|n| (n, prefix.to_owned())).collect();
    while let Some((node, prefix)) = stack.pop() {
        let Some(read) = read_node(doc, node) else {
            skipped = skipped.saturating_add(1);
            continue;
        };
        let path = if prefix.is_empty() {
            read.segment().to_owned()
        } else {
            format!("{prefix}/{}", read.segment())
        };
        for child in tree_children(doc, WORKSPACE_TREE_KEY, node).into_iter().rev() {
            stack.push((child, path.clone()));
        }
        out.push(Walked { id: node, read, path });
    }
    (out, skipped)
}

#[cfg(test)]
mod tests;
