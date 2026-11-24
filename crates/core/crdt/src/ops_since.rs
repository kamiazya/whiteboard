//! Which nodes of a tree the operations after a version landed under, and
//! whether they reorganised it, read off the operations rather than the tree,
//! so the cost follows the update (`opsSince`, `nodesWritten` and
//! `organisationChangedSince` in the TypeScript's `touched-documents.ts`).

use crate::tree::NodeId;
use loro::json::JsonOp;
use loro::{
    ContainerID, ContainerType, IdSpan, Index, JsonMapOp, JsonOpContent, LoroDoc, VersionVector,
};

/// The node a container sits under, and whether the container is below the
/// node's own map: a node's map is at `[tree, node]` and each content
/// container one level further down. A container below no node of `tree`
/// (another root, the tree itself, one under a node a delete took) answers
/// `None`. A root is compared by its id, which carries its kind: a map root
/// also named `tree` is no node's.
fn node_of(doc: &LoroDoc, tree: &ContainerID, container: &ContainerID) -> Option<(NodeId, bool)> {
    let path = doc.get_path_to_container(container)?;
    match path.as_slice() {
        [(root, _), (_, Index::Node(node)), rest @ ..] if root == tree => {
            Some((NodeId(*node), !rest.is_empty()))
        }
        _ => None,
    }
}

/// Every node of the tree root `tree` an operation after `since` landed
/// under, in the order the operations reach them, each once. A span starts no
/// earlier than the history the document kept, which is where an export
/// starts: a compacted document no longer holds its earliest operations.
#[must_use]
pub fn nodes_written_since(doc: &LoroDoc, tree: &str, since: &VersionVector) -> Vec<NodeId> {
    node_writes_since(doc, tree, since).into_iter().map(|(node, _)| node).collect()
}

/// Each peer's span of the operations beyond `since`, `(peer, start, end)`,
/// empty ones left out, in the order the oplog's version vector holds its
/// peers: a hash map's, which wasm32 and a native build iterate differently.
fn spans_since(doc: &LoroDoc, since: &VersionVector) -> Vec<(u64, i32, i32)> {
    let kept = doc.shallow_since_vv();
    doc.oplog_vv()
        .iter()
        .filter_map(|(&peer, &end)| {
            let start =
                since.get(&peer).copied().unwrap_or(0).max(kept.get(&peer).copied().unwrap_or(0));
            (end > start).then_some((peer, start, end))
        })
        .collect()
}

/// How many peers wrote operations beyond `since`. Past one, the order
/// [`node_writes_since`] names nodes in is the order the oplog's hash map
/// holds peers, which a native build does not share with wasm32.
#[must_use]
pub fn peers_written_since(doc: &LoroDoc, since: &VersionVector) -> usize {
    spans_since(doc, since).len()
}

/// Every operation the document holds beyond `since`, read as the span each
/// peer wrote. A span starts no earlier than the history the document kept,
/// which is where an export starts: a compacted document no longer holds its
/// earliest operations, and a span starting at one of them reads nothing.
fn ops_since(doc: &LoroDoc, since: &VersionVector) -> Vec<JsonOp> {
    let mut ops = Vec::new();
    for (peer, start, end) in spans_since(doc, since) {
        for change in doc.export_json_in_id_span(IdSpan::new(peer, start, end)) {
            ops.extend(change.ops);
        }
    }
    ops
}

/// [`nodes_written_since`], each node with whether an operation landed inside
/// one of its containers rather than only on its own map: a write to the
/// document's content, where a rename or a stamp writes only the node.
#[must_use]
pub fn node_writes_since(doc: &LoroDoc, tree: &str, since: &VersionVector) -> Vec<(NodeId, bool)> {
    let root = tree_root(tree);
    let mut nodes: Vec<(NodeId, bool)> = Vec::new();
    for op in ops_since(doc, since) {
        let Some((node, inside)) = node_of(doc, &root, &op.container) else { continue };
        match nodes.iter_mut().find(|(held, _)| *held == node) {
            Some((_, content)) => *content |= inside,
            None => nodes.push((node, inside)),
        }
    }
    nodes
}

fn tree_root(tree: &str) -> ContainerID {
    ContainerID::new_root(tree, ContainerType::Tree)
}

/// Whether an operation after `since` landed on the tree root `tree` itself:
/// a node created, moved or deleted.
#[must_use]
pub fn tree_written_since(doc: &LoroDoc, tree: &str, since: &VersionVector) -> bool {
    let root = tree_root(tree);
    ops_since(doc, since).iter().any(|op| op.container == root)
}

/// The container `id` was created in: a mergeable child names its parent in
/// its id, any other child is named by the operation that created it. `None`
/// for a root, and for a child whose creation the kept history no longer holds.
fn parent_of(doc: &LoroDoc, id: &ContainerID) -> Option<ContainerID> {
    match id {
        ContainerID::Root { .. } => id.parse_mergeable().map(|(parent, _, _)| parent),
        ContainerID::Normal { peer, counter, .. } => {
            let span = IdSpan::new(*peer, *counter, counter.checked_add(1)?);
            let changes = doc.export_json_in_id_span(span);
            let op = changes.into_iter().flat_map(|c| c.ops).find(|op| op.counter == *counter)?;
            Some(op.container)
        }
    }
}

/// Whether `id` was created below the root `tree`, read up its creation chain:
/// what places a container its path no longer reaches, one under a node a
/// delete took. `None` when the chain leaves the kept history.
fn created_under(doc: &LoroDoc, tree: &ContainerID, id: &ContainerID) -> Option<bool> {
    let mut at = id.clone();
    loop {
        if at == *tree {
            return Some(true);
        }
        if matches!(&at, ContainerID::Root { .. }) && !at.is_mergeable() {
            return Some(false);
        }
        at = parent_of(doc, &at)?;
    }
}

/// Where a container sits against the tree root.
enum Place {
    /// Not below the tree: another root or anything under one.
    Outside,
    /// Below the tree, with the keys of its path from the root (`None` under
    /// a node a delete took, which no path reaches).
    Below(Option<Vec<String>>),
}

fn step_key(index: &Index) -> String {
    match index {
        Index::Key(key) => key.to_string(),
        Index::Seq(at) => at.to_string(),
        Index::Node(node) => format!("{}@{}", node.counter, node.peer),
    }
}

/// The TypeScript's `descendsFromWorkspaceTree` then `getPathToContainer`.
/// `None` when where it sits cannot be read.
fn place_of(doc: &LoroDoc, tree: &ContainerID, container: &ContainerID) -> Option<Place> {
    match doc.get_path_to_container(container) {
        Some(path) => Some(match path.first() {
            Some((root, _)) if root == tree => {
                Place::Below(Some(path.iter().map(|(_, index)| step_key(index)).collect()))
            }
            _ => Place::Outside,
        }),
        None if created_under(doc, tree, container)? => Some(Place::Below(None)),
        None => Some(Place::Outside),
    }
}

/// The keys an organisation judge reads: those a node keeps for itself, and
/// those of them that say which document a node is and where it sits.
pub struct NodeKeys<'a> {
    pub meta: &'a [&'a str],
    pub placement: &'a [&'a str],
}

/// Whether one operation reorganises the tree: written on the tree itself or
/// outside it, inside a container held at a meta key (or a node's own map
/// held as one), or a placement key written on a node's own map.
fn reorganises(
    doc: &LoroDoc,
    root: &ContainerID,
    op: &JsonOp,
    keys: &NodeKeys<'_>,
) -> Option<bool> {
    if op.container == *root {
        return Some(true);
    }
    let Place::Below(path) = place_of(doc, root, &op.container)? else { return Some(true) };
    // A key past the node's own map, so a container below the node.
    let meta_held = path
        .as_ref()
        .and_then(|path| path.get(2))
        .is_some_and(|key| keys.meta.contains(&key.as_str()));
    if meta_held {
        return Some(true);
    }
    let depth = path.as_ref().map_or(0, Vec::len);
    let JsonOpContent::Map(JsonMapOp::Insert { key, .. } | JsonMapOp::Delete { key }) = &op.content
    else {
        return Some(false);
    };
    Some(keys.placement.contains(&key.as_str()) && depth == 2)
}

/// Whether the operations after `since` change how the tree root `tree`'s
/// record is organised rather than what its documents say: a node created,
/// deleted or moved, a placement key rewritten on a node's map, a write inside
/// a container a node holds at a meta key, or any write outside the tree.
/// One operation that reorganises answers `true` whatever the others are;
/// otherwise `None` when an operation's place cannot be read (one under a node
/// a delete took, whose creation the kept history no longer holds), since the
/// order the operations are read in is a hash map's.
#[must_use]
pub fn organisation_changed_since(
    doc: &LoroDoc,
    tree: &str,
    since: &VersionVector,
    keys: &NodeKeys<'_>,
) -> Option<bool> {
    let root = tree_root(tree);
    let mut unread = false;
    for op in ops_since(doc, since) {
        match reorganises(doc, &root, &op, keys) {
            Some(true) => return Some(true),
            Some(false) => {}
            None => unread = true,
        }
    }
    (!unread).then_some(false)
}
