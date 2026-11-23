//! Which nodes of a tree the operations after a version landed under, read off
//! the operations rather than the tree, so the cost follows the update
//! (`opsSince` and `nodesWritten` in the TypeScript's `touched-documents.ts`).

use crate::tree::NodeId;
use loro::{ContainerID, ContainerType, IdSpan, Index, LoroDoc, VersionVector};

/// The node a container sits under: a node's own map is at `[tree, node]`
/// and each content container one level further down. A container below no
/// node of `tree` (another root, the tree itself, one under a node a delete
/// took) answers `None`. A root is compared by its id, which carries its kind:
/// a map root also named `tree` is no node's.
fn node_of(doc: &LoroDoc, tree: &ContainerID, container: &ContainerID) -> Option<NodeId> {
    let path = doc.get_path_to_container(container)?;
    match path.as_slice() {
        [(root, _), (_, Index::Node(node)), ..] if root == tree => Some(NodeId(*node)),
        _ => None,
    }
}

/// Every node of the tree root `tree` an operation after `since` landed
/// under, in the order the operations reach them, each once. A span starts no
/// earlier than the history the document kept, which is where an export
/// starts: a compacted document no longer holds its earliest operations.
#[must_use]
pub fn nodes_written_since(doc: &LoroDoc, tree: &str, since: &VersionVector) -> Vec<NodeId> {
    let root = ContainerID::new_root(tree, ContainerType::Tree);
    let kept = doc.shallow_since_vv();
    let mut nodes: Vec<NodeId> = Vec::new();
    for (&peer, &end) in doc.oplog_vv().iter() {
        let start =
            since.get(&peer).copied().unwrap_or(0).max(kept.get(&peer).copied().unwrap_or(0));
        if end <= start {
            continue;
        }
        for change in doc.export_json_in_id_span(IdSpan::new(peer, start, end)) {
            for op in change.ops {
                if let Some(node) = node_of(doc, &root, &op.container)
                    && !nodes.contains(&node)
                {
                    nodes.push(node);
                }
            }
        }
    }
    nodes
}
