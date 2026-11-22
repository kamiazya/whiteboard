//! Copying a subtree of a tree container node by node, in tree order, into
//! another position or another document: how a deleted document leaves the
//! record as bytes and how those bytes come back.

use crate::copy::{NodeAt, copy_meta};
use crate::tree::{ContainerKind, NodeId, Tree};
use crate::write::{WriteError, create_node};
use loro::{ExportMode, LoroDoc};

/// What a subtree copy carries and adds, per node.
pub struct SubtreeCopy<'a> {
    /// Which of a node's meta entries travel (see [`copy_meta`]).
    pub wanted: &'a dyn Fn(&str, Option<ContainerKind>) -> bool,
    /// What each copied node is given once its meta is in: told the source node and the new one.
    pub finish: &'a dyn Fn(NodeAt<'_>, NodeAt<'_>) -> Result<(), WriteError>,
}

/// The nodes of the subtree rooted at `from` in the order a copy makes them:
/// parents before children and siblings in order, each with the index of its
/// parent among them.
fn subtree_order(from: NodeAt<'_>) -> Vec<(NodeId, Option<usize>)> {
    let source_tree = Tree(from.doc.get_tree(from.tree));
    let mut order: Vec<(NodeId, Option<usize>)> = Vec::new();
    let mut stack: Vec<(NodeId, Option<usize>)> = vec![(from.node, None)];
    while let Some((source, above)) = stack.pop() {
        let at = order.len();
        order.push((source, above));
        for child in source_tree.children(source).into_iter().rev() {
            stack.push((child, Some(at)));
        }
    }
    order
}

/// Copies the subtree rooted at `from` under `parent` (a root when `None`) of
/// the tree `into` names, parents before children and siblings in order, and
/// answers the copy of `from`. The subtree is read before the first node is
/// made, so copying it under one of its own nodes copies what was there.
///
/// A write that fails part-way leaves the nodes made so far: undoing them
/// would append operations of its own, so the holder of the record drops it, as
/// the TypeScript engine restores a record whose write threw.
pub fn copy_subtree(
    from: NodeAt<'_>,
    into: (&LoroDoc, &str),
    parent: Option<NodeId>,
    how: &SubtreeCopy<'_>,
) -> Result<NodeId, WriteError> {
    let mut made: Vec<NodeId> = Vec::new();
    for (source, above) in subtree_order(from) {
        let under = above.and_then(|at| made.get(at).copied()).or(parent);
        let node = create_node(into.0, into.1, under)?;
        let here = NodeAt { node: source, ..from };
        let there = NodeAt { doc: into.0, tree: into.1, node };
        copy_meta(here, there, how.wanted)?;
        (how.finish)(here, there)?;
        made.push(node);
    }
    made.first().copied().ok_or_else(|| WriteError("a subtree always has its root".to_owned()))
}

/// The subtree rooted at `from` as a document of its own: a value copy with no
/// history, exported as a snapshot.
pub fn export_subtree(from: NodeAt<'_>, how: &SubtreeCopy<'_>) -> Result<Vec<u8>, WriteError> {
    let out = LoroDoc::new();
    copy_subtree(from, (&out, from.tree), None, how)?;
    out.commit();
    Ok(out.export(ExportMode::Snapshot)?)
}
