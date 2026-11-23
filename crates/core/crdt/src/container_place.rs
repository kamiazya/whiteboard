//! Which tree node a container sits under, named by its id as the wire spells
//! it (`containerPlace` in the TypeScript's `container-place.ts`, up to the
//! document the node holds, which the workspace record answers).

use crate::tree::NodeId;
use loro::{Container, ContainerID, Index, LoroDoc};

/// The tree node the container `id` names sits under, and a text container's
/// length in UTF-16 units. `None` for an id loro does not read, one whose
/// creating operation the record lacks (no parent can be read for it), and one
/// no path reaches below a tree node: a root, a tree itself, anything under a
/// root of another kind or under a node a delete took. A node id names the
/// node of one tree only, so the caller that looks it up in its own tree
/// finds none for a container under another.
#[must_use]
pub fn container_node(doc: &LoroDoc, id: &str) -> Option<(NodeId, Option<usize>)> {
    let container = ContainerID::try_from(id).ok()?;
    if let ContainerID::Normal { peer, counter, .. } = &container {
        let held = doc.oplog_vv().get(peer).copied().unwrap_or(0);
        if held <= *counter {
            return None;
        }
    }
    let path = doc.get_path_to_container(&container)?;
    let [_, (_, Index::Node(node)), ..] = path.as_slice() else { return None };
    let node = NodeId(*node);
    let length = match doc.get_container(container) {
        Some(Container::Text(text)) => Some(text.len_utf16()),
        _ => None,
    };
    Some((node, length))
}
