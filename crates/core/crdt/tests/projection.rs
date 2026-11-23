//! A document hosted on a tree node, copied out as a document of its own: its
//! containers become roots, its scalars stay behind with the tree, and a mark on
//! its text survives the copy.

use loro::{
    ExpandType, LoroDoc, LoroMap, LoroMovableList, LoroText, LoroValue, StyleConfig,
    StyleConfigMap, loro_value,
};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{NodeAt, NodeId, deep_value, project_node, project_node_without, tree};
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

/// The numbers a value holds as npm loro-crdt stores them once JavaScript has
/// read them: a whole double within 2^53 an integer, a negative zero the
/// integer zero, an integer past 2^53 the double it rounds to. The real
/// engine's `duplicateWorkspaceDocument` copies `{ x: 1.0, y: -0.0, z: 2^60 + 1 }`
/// so, through the projection this is (the `dup-foreign` row of
/// `crates/core/workspace-index/tests/fixtures/workspace_record_write_cases.jsonl`).
#[test]
fn a_copied_value_holds_its_numbers_as_javascript_would_store_them() {
    let doc = LoroDoc::new();
    let id = doc.get_tree("tree").create(None).expect("a node");
    let meta = doc.get_tree("tree").get_meta(id).expect("meta");
    let nodes = meta.insert_container("nodes", LoroMap::new()).expect("nodes");
    let big = 1_152_921_504_606_846_977_i64;
    nodes.insert("n1", loro_value!({ "x": 1.0, "y": -0.0, "z": big, "w": 2.5 })).expect("a value");
    nodes.insert("one", 1.0).expect("a double");
    nodes.insert("inner", LoroValue::List(vec![LoroValue::Double(3.0)].into())).expect("a list");
    meta.insert_container("threads", LoroMap::new()).expect("threads").insert("t", 1).expect("t");
    let list = meta.insert_container("elements", LoroMovableList::new()).expect("a list");
    list.push(LoroValue::Double(4.0)).expect("an item");
    doc.commit();
    let node = tree(&doc, "tree").expect("a tree").roots()[0];
    let at = NodeAt { doc: &doc, tree: "tree", node };
    let projected = project_node_without(at, &["threads"]).expect("a copy");
    let rounded = 1_152_921_504_606_846_976.0;
    let expected = loro_value!({
        "n1": { "x": 1_i64, "y": 0_i64, "z": rounded, "w": 2.5 },
        "one": 1_i64,
        "inner": [3_i64],
    });
    assert_eq!(projected.get_map("nodes").get_deep_value(), expected);
    assert_eq!(projected.get_movable_list("elements").get_deep_value(), loro_value!([4_i64]));
    assert!(
        projected.get_deep_value().as_map().is_some_and(|roots| !roots.contains_key("threads"))
    );
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
