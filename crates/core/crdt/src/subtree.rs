//! Copying a subtree of a tree container node by node, in tree order, into
//! another position or another document: how a deleted document leaves the
//! record as bytes and how those bytes come back.

use crate::copy::{NodeAt, copy_meta};
use crate::tree::{ContainerKind, NodeId, tree_children};
use crate::write::{WriteError, create_node};
use loro::{ExportMode, LoroDoc};

/// What a subtree copy carries and adds, per node.
pub struct SubtreeCopy<'a> {
    /// Which of a node's meta entries travel (see [`copy_meta`]).
    pub wanted: &'a dyn Fn(&str, Option<ContainerKind>) -> bool,
    /// What each copied node is given once its meta is in: told the source node and the new one.
    pub finish: &'a dyn Fn(NodeAt<'_>, NodeAt<'_>) -> Result<(), WriteError>,
}

/// Copies the subtree rooted at `from` under `parent` (a root when `None`) of
/// the tree `into` names, parents before children and siblings in order, and
/// answers the copy of `from`.
pub fn copy_subtree(
    from: NodeAt<'_>,
    into: (&LoroDoc, &str),
    parent: Option<NodeId>,
    how: &SubtreeCopy<'_>,
) -> Result<NodeId, WriteError> {
    let mut copied: Option<NodeId> = None;
    let mut stack: Vec<(NodeId, Option<NodeId>)> = vec![(from.node, parent)];
    while let Some((source, under)) = stack.pop() {
        let node = create_node(into.0, into.1, under)?;
        let here = NodeAt { node: source, ..from };
        let there = NodeAt { doc: into.0, tree: into.1, node };
        copy_meta(here, there, how.wanted)?;
        (how.finish)(here, there)?;
        copied.get_or_insert(node);
        for child in tree_children(from.doc, from.tree, source).into_iter().rev() {
            stack.push((child, Some(node)));
        }
    }
    copied.ok_or_else(|| WriteError("a subtree always has its root".to_owned()))
}

/// The subtree rooted at `from` as a document of its own: a value copy with no
/// history, exported as a snapshot.
pub fn export_subtree(from: NodeAt<'_>, how: &SubtreeCopy<'_>) -> Result<Vec<u8>, WriteError> {
    let out = LoroDoc::new();
    copy_subtree(from, (&out, from.tree), None, how)?;
    out.commit();
    Ok(out.export(ExportMode::Snapshot)?)
}
