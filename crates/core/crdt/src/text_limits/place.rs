//! Where a container sits in the document: the path the judge finds every
//! bound by, as the TypeScript's `getPathToContainer` spells it.
//!
//! Each step is written as the string the TypeScript compares it against: a
//! key as itself, a tree node as `counter@peer`, a list position as its
//! number. A key spelled like a tree node's id compares equal to one there
//! too, so nothing a comparison here can tell apart is lost.

use loro::{Container, ContainerID, Index, LoroDoc, LoroMap, LoroValue, ValueOrContainer};

/// The root a workspace record keeps its documents' nodes under.
pub(super) const TREE_KEY: &str = "tree";

/// A container's path from its root: each step's container and key.
pub(super) struct Place(Vec<(ContainerID, String)>);

/// Where `id` sits, `None` for a container the state no longer reaches.
pub(super) fn place_of(doc: &LoroDoc, id: &ContainerID) -> Option<Place> {
    let path = doc.get_path_to_container(id)?;
    Some(Place(path.into_iter().map(|(step, index)| (step, segment(&index))).collect()))
}

fn segment(index: &Index) -> String {
    match index {
        Index::Key(key) => key.to_string(),
        Index::Seq(at) => at.to_string(),
        Index::Node(node) => format!("{}@{}", node.counter, node.peer),
    }
}

impl Place {
    pub(super) fn len(&self) -> usize {
        self.0.len()
    }

    /// The key of step `at`, `None` past the path.
    pub(super) fn key(&self, at: usize) -> Option<&str> {
        self.0.get(at).map(|(_, key)| key.as_str())
    }

    /// The key `back` steps from the end: 1 is the container's own.
    pub(super) fn key_back(&self, back: usize) -> Option<&str> {
        self.len().checked_sub(back).and_then(|at| self.key(at))
    }

    /// The container at step `at`.
    pub(super) fn id(&self, at: usize) -> Option<&ContainerID> {
        self.0.get(at).map(|(id, _)| id)
    }

    /// Whether the path runs through a workspace record's tree.
    pub(super) fn under_tree(&self) -> bool {
        self.key(0) == Some(TREE_KEY)
    }

    /// Whether the container is `depth` steps below a document: under a root
    /// of its own, or under a workspace tree node, which adds two steps.
    pub(super) fn at_document_depth(&self, depth: usize) -> bool {
        self.len() == depth || (self.len() == depth.saturating_add(2) && self.under_tree())
    }

    /// Whether the container is one of a document's content containers.
    pub(super) fn is_content(&self) -> bool {
        self.at_document_depth(1)
    }

    /// Whether the container is the content container `key` names.
    pub(super) fn is_content_at(&self, key: &str) -> bool {
        self.is_content() && self.key_back(1) == Some(key)
    }

    /// The steps above the document the path runs through, `/`-joined: empty
    /// for a document that is its own root.
    pub(super) fn document_prefix(&self) -> String {
        let base = if self.under_tree() { 2 } else { 0 };
        let steps: Vec<&str> = self.0.iter().take(base).map(|(_, key)| key.as_str()).collect();
        steps.join("/")
    }

    /// The path below the document.
    pub(super) fn relative(&self) -> Vec<&str> {
        let base = if self.under_tree() { 2 } else { 0 };
        self.0.iter().skip(base).map(|(_, key)| key.as_str()).collect()
    }

    /// The container at the document's own level, which `relative` starts from.
    pub(super) fn document_level(&self) -> Option<&ContainerID> {
        self.id(if self.under_tree() { 2 } else { 0 })
    }
}

/// The map `id` names in the state, `None` for any other container.
pub(super) fn map_at(doc: &LoroDoc, id: &ContainerID) -> Option<LoroMap> {
    match doc.get_container(id.clone())? {
        Container::Map(map) => Some(map),
        _ => None,
    }
}

/// The plain value `map` holds at `key`, `None` for nothing or a container.
pub(super) fn value_at(map: &LoroMap, key: &str) -> Option<LoroValue> {
    match map.get(key)? {
        ValueOrContainer::Value(value) => Some(value),
        ValueOrContainer::Container(_) => None,
    }
}

/// The map `map` holds at `key`, `None` for nothing, a value or another kind.
pub(super) fn child_map(map: &LoroMap, key: &str) -> Option<LoroMap> {
    match map.get(key)? {
        ValueOrContainer::Container(Container::Map(child)) => Some(child),
        _ => None,
    }
}

/// The roots the state lists, by name: what the TypeScript's shallow value holds.
pub(super) fn roots(doc: &LoroDoc) -> Vec<(String, ContainerID)> {
    let LoroValue::Map(held) = doc.get_value() else { return Vec::new() };
    held.iter()
        .filter_map(|(name, value)| match value {
            LoroValue::Container(id) => Some((name.clone(), id.clone())),
            _ => None,
        })
        .collect()
}

/// Whether the state lists a root named `name`.
pub(super) fn has_root(doc: &LoroDoc, name: &str) -> bool {
    roots(doc).iter().any(|(held, _)| held == name)
}

/// `text`'s length in UTF-16 units, the unit every bound counts.
pub(super) fn units(text: &str) -> usize {
    text.encode_utf16().count()
}
