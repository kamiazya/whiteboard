//! A document hosted on a tree node, copied out as a document of its own: its
//! containers become roots, its scalars stay behind with the tree, and a mark on
//! its text survives the copy.

use loro::{ExpandType, LoroDoc, LoroMap, LoroMovableList, LoroText, StyleConfig, StyleConfigMap};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{NodeAt, NodeId, deep_value, project_node, tree};
use whiteboard_model::Value;

#[cfg(test)]
fn hosted() -> (LoroDoc, NodeId) {
    let doc = LoroDoc::new();
    doc.set_peer_id(7).expect("a peer");
    let mut styles = StyleConfigMap::new();
    styles.insert("bold".into(), StyleConfig { expand: ExpandType::After });
    doc.config_text_style(styles);
    let held = doc.get_tree("tree");
    let id = held.create(None).expect("a node");
    let meta = held.get_meta(id).expect("meta");
    meta.insert("segment", "a").expect("a scalar");
    let body = meta.insert_container("body", LoroText::new()).expect("a body");
    body.insert(0, "hello").expect("text");
    body.mark(0..2, "bold", true).expect("a mark");
    let nodes = meta.insert_container("nodes", LoroMap::new()).expect("nodes");
    nodes.insert("n1", "x").expect("an entry");
    let list = meta.insert_container("elements", LoroMovableList::new()).expect("a list");
    list.push(1).expect("an item");
    let plane = meta.insert_container("plane:x", LoroMap::new()).expect("a plane");
    plane.insert("k", "v").expect("an entry");
    doc.commit();
    let node = tree(&doc, "tree").expect("a tree").roots()[0];
    (doc, node)
}

#[test]
fn the_containers_become_roots_and_the_scalars_and_planes_stay_behind() {
    let (doc, node) = hosted();
    let projected = project_node(NodeAt { doc: &doc, tree: "tree", node }).expect("a copy");
    let map = |entries: Vec<(&str, Value)>| {
        Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    };
    let expected = map(vec![
        ("body", Value::String("hello".into())),
        ("elements", Value::Seq(vec![Value::Number(1.0)])),
        ("nodes", map(vec![("n1", Value::String("x".into()))])),
    ]);
    assert_eq!(deep_value(&projected), expected);
}

#[test]
fn a_mark_on_the_text_survives_and_the_copy_has_a_history_of_its_own() {
    let (doc, node) = hosted();
    let projected = project_node(NodeAt { doc: &doc, tree: "tree", node }).expect("a copy");
    let runs = projected.get_text("body").to_delta();
    assert_eq!(runs.len(), 2);
    assert_eq!(format!("{:?}", runs[0]).matches("bold").count(), 1);
    assert_ne!(projected.oplog_vv(), doc.oplog_vv());
}

#[test]
fn a_node_the_tree_does_not_hold_is_refused() {
    let (doc, node) = hosted();
    let other = LoroDoc::new();
    assert!(project_node(NodeAt { doc: &other, tree: "tree", node }).is_err());
    drop(doc);
}

#[test]
fn a_tree_node_is_named_by_its_counter_and_its_peer() {
    let (_, node) = hosted();
    assert_eq!(node.to_string(), "0@7");
}
