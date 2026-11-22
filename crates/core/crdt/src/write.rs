//! Writing a record's tree and the containers beside it, one loro call for one
//! npm loro-crdt call, so the operations a write appends (and the version
//! vector they move) are the ones the TypeScript's writers append.
//!
//! A map insert that already holds the value appends nothing, on either side;
//! a container opened where one stands appends nothing either.

use crate::read::loro_value_to_value;
use crate::tree::{ContainerKind, NodeId};
use loro::{
    Container, LoroDoc, LoroList, LoroMap, LoroMapValue, LoroMovableList, LoroText, LoroValue,
    ValueOrContainer,
};
use whiteboard_model::Value;

/// Why a write did not apply: loro's own refusal, in its words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteError(pub String);

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WriteError {}

impl From<loro::LoroEncodeError> for WriteError {
    fn from(error: loro::LoroEncodeError) -> Self {
        refused(error)
    }
}

impl From<loro::LoroError> for WriteError {
    fn from(error: loro::LoroError) -> Self {
        refused(error)
    }
}

pub(crate) fn refused(error: impl std::fmt::Display) -> WriteError {
    WriteError(error.to_string())
}

/// Ends the change in progress: the operations written since the last commit
/// join the oplog, so the version vector counts them.
pub fn commit(doc: &LoroDoc) {
    doc.commit();
}

/// The document's peer id: every operation written after this is its own.
pub fn set_peer_id(doc: &LoroDoc, peer: u64) -> Result<(), WriteError> {
    doc.set_peer_id(peer).map_err(refused)
}

/// A plain value as loro stores it: a whole number is an integer, as npm
/// loro-crdt stores one, and anything else a double.
fn plain(value: &Value) -> Result<LoroValue, WriteError> {
    Ok(match value {
        Value::Null => LoroValue::Null,
        Value::Bool(b) => LoroValue::Bool(*b),
        Value::Number(n) => whole_number(*n).map_or(LoroValue::Double(*n), LoroValue::I64),
        Value::String(s) => LoroValue::from(s.as_str()),
        Value::Seq(items) => {
            LoroValue::from(items.iter().map(plain).collect::<Result<Vec<_>, _>>()?)
        }
        Value::Map(entries) => LoroValue::Map(
            entries
                .iter()
                .map(|(k, v)| Ok((k.clone(), plain(v)?)))
                .collect::<Result<LoroMapValue, WriteError>>()?,
        ),
        Value::BigInt(_) => return Err(WriteError("a big integer is not a loro value".to_owned())),
    })
}

/// `n` as an integer when it is a whole number within +-2^53, the range npm loro-crdt stores as an integer.
fn whole_number(n: f64) -> Option<i64> {
    const EXACT: f64 = 9_007_199_254_740_992.0;
    (n.fract() == 0.0 && n.abs() <= EXACT).then(|| n.to_string().parse().ok()).flatten()
}

fn meta_of(doc: &LoroDoc, tree: &str, node: NodeId) -> Result<LoroMap, WriteError> {
    doc.get_tree(tree).get_meta(node.0).map_err(refused)
}

/// A new node under `parent` (a root when `None`), after its siblings.
pub fn create_node(
    doc: &LoroDoc,
    tree: &str,
    parent: Option<NodeId>,
) -> Result<NodeId, WriteError> {
    doc.get_tree(tree).create(parent.map(|p| p.0)).map(NodeId).map_err(refused)
}

/// Re-parents `node` under `parent` (a root when `None`), after its siblings.
pub fn move_node(
    doc: &LoroDoc,
    tree: &str,
    node: NodeId,
    parent: Option<NodeId>,
) -> Result<(), WriteError> {
    doc.get_tree(tree).mov(node.0, parent.map(|p| p.0)).map_err(refused)
}

/// Deletes `node` with everything below it.
pub fn delete_node(doc: &LoroDoc, tree: &str, node: NodeId) -> Result<(), WriteError> {
    doc.get_tree(tree).delete(node.0).map_err(refused)
}

/// Sets the plain value at `key` of `node`'s meta map.
pub fn set_meta(
    doc: &LoroDoc,
    tree: &str,
    node: NodeId,
    key: &str,
    value: &Value,
) -> Result<(), WriteError> {
    meta_of(doc, tree, node)?.insert(key, plain(value)?).map_err(refused)
}

/// Removes `key` from `node`'s meta map. A delete is an operation even for a
/// key that was never there, so callers ask [`Tree::entry`](crate::Tree::entry) first.
pub fn delete_meta(doc: &LoroDoc, tree: &str, node: NodeId, key: &str) -> Result<(), WriteError> {
    meta_of(doc, tree, node)?.delete(key).map_err(refused)
}

fn container_of(kind: ContainerKind) -> Option<Container> {
    match kind {
        ContainerKind::Map => Some(Container::Map(LoroMap::new())),
        ContainerKind::List => Some(Container::List(LoroList::new())),
        ContainerKind::MovableList => Some(Container::MovableList(LoroMovableList::new())),
        ContainerKind::Text => Some(Container::Text(LoroText::new())),
        ContainerKind::Tree | ContainerKind::Other => None,
    }
}

/// The container of `kind` at `key` of `node`'s meta map, made when absent
/// with an op-created id: a container already standing there is left alone.
pub fn open_meta_container(
    doc: &LoroDoc,
    tree: &str,
    node: NodeId,
    key: &str,
    kind: ContainerKind,
) -> Result<(), WriteError> {
    let Some(child) = container_of(kind) else {
        return Err(WriteError("a tree or an unknown container cannot be opened here".to_owned()));
    };
    let meta = meta_of(doc, tree, node)?;
    if meta.get(key).is_some() {
        return Ok(());
    }
    meta.insert_container(key, child).map(|_| ()).map_err(refused)
}

/// The movable list at `key` of the root map `root`, made mergeable when the
/// key is absent and opened as it stands otherwise, so peers that each open it
/// first agree on one list.
pub fn open_root_list(doc: &LoroDoc, root: &str, key: &str) -> Result<LoroMovableList, WriteError> {
    let map = doc.get_map(root);
    match map.get(key) {
        None => map.ensure_mergeable_movable_list(key).map_err(refused),
        Some(ValueOrContainer::Container(Container::MovableList(list))) => Ok(list),
        Some(_) => Err(WriteError(format!("{root}/{key} does not hold a movable list"))),
    }
}

/// Sets the plain value at `key` of the root map `root`.
pub fn set_root_entry(
    doc: &LoroDoc,
    root: &str,
    key: &str,
    value: &Value,
) -> Result<(), WriteError> {
    doc.get_map(root).insert(key, plain(value)?).map_err(refused)
}

/// Removes `key` from the root map `root`.
pub fn delete_root_entry(doc: &LoroDoc, root: &str, key: &str) -> Result<(), WriteError> {
    doc.get_map(root).delete(key).map_err(refused)
}

/// The deep value with every container's id beside it, as npm loro-crdt's
/// `getDeepValueWithID` answers it.
#[must_use]
pub fn deep_value_with_id(doc: &LoroDoc) -> Value {
    loro_value_to_value(&doc.get_deep_value_with_id())
}
