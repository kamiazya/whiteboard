//! Reading a record's tree and the roots beside it without writing to it.
//!
//! A read that opens a container a document never held registers it, and a
//! snapshot then carries the empty root, so the bytes of a record would depend
//! on who looked. Everything here asks for what is there and answers `None`
//! or an empty list for what is not.

use crate::read::loro_value_to_value;
use loro::{Container, ContainerType, LoroDoc, LoroTree, LoroValue, TreeID, ValueOrContainer};
use whiteboard_model::Value;

/// A node of a tree container, named by the tree's own id for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeId(pub(crate) TreeID);

impl std::fmt::Display for NodeId {
    /// `counter@peer`, as the tree names its nodes.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}@{}", self.0.counter, self.0.peer)
    }
}

/// What kind of container a map's entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerKind {
    Map,
    List,
    MovableList,
    Text,
    Tree,
    Other,
}

/// One entry of a node's meta map: a plain value, or a container with the
/// deep value it holds.
#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    Value(Value),
    Container { kind: ContainerKind, value: Value },
}

/// A tree container the document holds, resolved once. Finding it asks the
/// document which roots it registers, which costs the size of the tree, so a
/// read resolves it once and asks the handle for every node it reads.
pub struct Tree(pub(crate) LoroTree);

/// The tree root `name`, only when the document holds one: `get_tree` on a
/// name the document lacks registers an empty root, which the next snapshot
/// then carries. The shallow value lists exactly the roots the state holds.
#[must_use]
pub fn tree(doc: &LoroDoc, name: &str) -> Option<Tree> {
    let LoroValue::Map(roots) = doc.get_value() else { return None };
    match roots.get(name) {
        Some(LoroValue::Container(id)) if id.container_type() == ContainerType::Tree => {
            Some(Tree(doc.get_tree(name)))
        }
        _ => None,
    }
}

impl Tree {
    /// The live roots, in tree order.
    #[must_use]
    pub fn roots(&self) -> Vec<NodeId> {
        self.0.roots().into_iter().map(NodeId).collect()
    }

    /// The live children of `node`, in tree order.
    #[must_use]
    pub fn children(&self, node: NodeId) -> Vec<NodeId> {
        self.0.children(node.0).unwrap_or_default().into_iter().map(NodeId).collect()
    }

    /// The keys of `node`'s meta map, ascending.
    #[must_use]
    pub fn keys(&self, node: NodeId) -> Vec<String> {
        let Ok(meta) = self.0.get_meta(node.0) else { return Vec::new() };
        let mut keys: Vec<String> = meta.keys().map(|key| key.to_string()).collect();
        keys.sort();
        keys
    }

    /// The entry of `node`'s meta map at `key`.
    #[must_use]
    pub fn entry(&self, node: NodeId, key: &str) -> Option<Entry> {
        let meta = self.0.get_meta(node.0).ok()?;
        Some(entry_of(&meta.get(key)?))
    }
}

pub(crate) fn kind_of(container: &Container) -> ContainerKind {
    match container {
        Container::Map(_) => ContainerKind::Map,
        Container::List(_) => ContainerKind::List,
        Container::MovableList(_) => ContainerKind::MovableList,
        Container::Text(_) => ContainerKind::Text,
        Container::Tree(_) => ContainerKind::Tree,
        _ => ContainerKind::Other,
    }
}

fn entry_of(held: &ValueOrContainer) -> Entry {
    let value = loro_value_to_value(&held.get_deep_value());
    match held {
        ValueOrContainer::Value(_) => Entry::Value(value),
        ValueOrContainer::Container(container) => {
            Entry::Container { kind: kind_of(container), value }
        }
    }
}

/// What the record holds at `path` (a root container, then keys), or `None`
/// when nothing is there.
#[must_use]
pub fn peek(doc: &LoroDoc, path: &str) -> Option<Entry> {
    Some(entry_of(&doc.get_by_str_path(path)?))
}
