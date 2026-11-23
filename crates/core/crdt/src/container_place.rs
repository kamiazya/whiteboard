//! Which tree node a container sits under, named by its id as the wire spells
//! it (`containerPlace` in the TypeScript's `container-place.ts`, up to the
//! document the node holds, which the workspace record answers).

use crate::tree::NodeId;
use loro::{Container, ContainerID, ContainerType, Index, LoroDoc};

/// The node of the tree root `tree` the container `id` names sits under, and
/// a text container's length in UTF-16 units. `None` for an id loro does not
/// read, one whose creating operation the record lacks (no parent can be read
/// for it), and one no path reaches below a node: a root, the tree itself,
/// anything under another root or under a node a delete took.
#[must_use]
pub fn container_node(doc: &LoroDoc, tree: &str, id: &str) -> Option<(NodeId, Option<usize>)> {
    let container = ContainerID::try_from(id).ok()?;
    if let ContainerID::Normal { peer, counter, .. } = &container {
        let held = doc.oplog_vv().get(peer).copied().unwrap_or(0);
        if held <= *counter {
            return None;
        }
    }
    let path = doc.get_path_to_container(&container)?;
    let root = ContainerID::new_root(tree, ContainerType::Tree);
    let node = match path.as_slice() {
        [(first, _), (_, Index::Node(node)), ..] if *first == root => NodeId(*node),
        _ => return None,
    };
    let length = match doc.get_container(container) {
        Some(Container::Text(text)) => Some(text.len_utf16()),
        _ => None,
    };
    Some((node, length))
}
