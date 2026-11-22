//! Reading a record's tree and the roots beside it without writing to it.
//!
//! A read that opens a container a document never held registers it, and a
//! snapshot then carries the empty root, so the bytes of a record would depend
//! on who looked. Everything here asks for what is there and answers `None`
//! or an empty list for what is not.

use crate::read::loro_value_to_value;
use loro::{Container, LoroDoc, TreeID, ValueOrContainer};
use whiteboard_model::Value;

/// A node of a tree container, named by the tree's own id for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeId(TreeID);

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

/// The live roots of the tree container `name`, in tree order.
#[must_use]
pub fn tree_roots(doc: &LoroDoc, name: &str) -> Vec<NodeId> {
    doc.get_tree(name).roots().into_iter().map(NodeId).collect()
}

/// The live children of `node`, in tree order.
#[must_use]
pub fn tree_children(doc: &LoroDoc, name: &str, node: NodeId) -> Vec<NodeId> {
    doc.get_tree(name).children(node.0).unwrap_or_default().into_iter().map(NodeId).collect()
}

/// The keys of `node`'s meta map, ascending.
#[must_use]
pub fn node_keys(doc: &LoroDoc, name: &str, node: NodeId) -> Vec<String> {
    let Ok(meta) = doc.get_tree(name).get_meta(node.0) else { return Vec::new() };
    let mut keys: Vec<String> = meta.keys().map(|key| key.to_string()).collect();
    keys.sort();
    keys
}

/// The entry of `node`'s meta map at `key`.
#[must_use]
pub fn node_entry(doc: &LoroDoc, name: &str, node: NodeId, key: &str) -> Option<Entry> {
    let meta = doc.get_tree(name).get_meta(node.0).ok()?;
    Some(entry_of(&meta.get(key)?))
}

fn kind_of(container: &Container) -> ContainerKind {
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
