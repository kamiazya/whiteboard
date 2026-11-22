//! Workspace records built in memory for the unit tests, with the stored
//! shapes a hostile or older writer may leave.

use whiteboard_crdt::{ExportMode, LoroDoc, LoroMap, TreeID};

pub(crate) const ID_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
pub(crate) const ID_B: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
pub(crate) const ID_C: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAC";

/// A node's meta as a document records it, created and updated at 1 and 2.
pub(crate) fn document_meta(id: &str, segment: &str) -> Vec<(&'static str, String)> {
    vec![
        ("documentId", id.to_owned()),
        ("segment", segment.to_owned()),
        ("kind", "markdown".to_owned()),
    ]
}

/// A node under `parent` (a root when `None`), its meta set from `meta`.
pub(crate) fn add_node(doc: &LoroDoc, parent: Option<TreeID>, meta: &[(&str, String)]) -> TreeID {
    let tree = doc.get_tree("tree");
    let id = match parent {
        Some(parent) => tree.create(parent),
        None => tree.create(None),
    }
    .expect("a tree node is created");
    let data = tree.get_meta(id).expect("a created node has meta");
    for (key, value) in meta {
        data.insert(key, value.as_str()).expect("a map takes a string");
    }
    id
}

pub(crate) fn meta_of(doc: &LoroDoc, node: TreeID) -> LoroMap {
    doc.get_tree("tree").get_meta(node).expect("a node has meta")
}

/// The snapshot a keeper would store for `doc`.
pub(crate) fn snapshot(doc: &LoroDoc) -> Vec<u8> {
    doc.commit();
    doc.export(ExportMode::Snapshot).expect("a snapshot exports")
}

/// A record a keeper would write, over `doc`'s snapshot, as the peer the oracle replays as.
pub(crate) fn writable(doc: &LoroDoc) -> crate::WorkspaceRecord {
    crate::WorkspaceRecord::open_as(&snapshot(doc), 1).expect("a snapshot opens")
}

/// A canonical document id for the nth test document.
pub(crate) fn id_of(n: usize) -> String {
    format!("01ARZ3NDEKTSV4RRFF{n:08}")
}

/// The first node's tree of a test record, which every test record holds.
pub(crate) fn tree_of(doc: &LoroDoc) -> whiteboard_crdt::Tree {
    whiteboard_crdt::tree(doc, "tree").expect("a record that holds a tree")
}
