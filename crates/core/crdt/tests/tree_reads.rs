//! A tree and the roots beside it, read without writing to the record.

use loro::{LoroDoc, LoroMap, LoroMovableList, LoroText, TreeID};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ContainerKind, Entry, NodeId, deep_value, peek, tree};
use whiteboard_model::Value;

fn node_result(doc: &LoroDoc, parent: Option<TreeID>) -> loro::LoroResult<TreeID> {
    let tree = doc.get_tree("t");
    match parent {
        Some(parent) => tree.create(parent),
        None => tree.create(None),
    }
}

macro_rules! node {
    ($doc:expr, $parent:expr) => {
        node_result($doc, $parent).expect("a node")
    };
}

#[test]
fn roots_and_children_come_in_tree_order() {
    let doc = LoroDoc::new();
    let first = node!(&doc, None);
    node!(&doc, None);
    let child_a = node!(&doc, Some(first));
    let child_b = node!(&doc, Some(first));
    let roots = tree(&doc, "t").expect("a tree").roots();
    assert_eq!(roots.len(), 2);
    let under = tree(&doc, "t").expect("a tree").children(roots[0]);
    assert_eq!(under.len(), 2);
    assert_eq!(tree(&doc, "t").expect("a tree").children(roots[1]).len(), 0);
    let expected = doc.get_tree("t").children(first).expect("children");
    assert_eq!(expected, vec![child_a, child_b]);
}

#[test]
fn a_deleted_node_is_not_listed() {
    let doc = LoroDoc::new();
    node!(&doc, None);
    let gone = node!(&doc, None);
    doc.get_tree("t").delete(gone).expect("deleted");
    assert_eq!(tree(&doc, "t").expect("a tree").roots().len(), 1);
}

#[test]
fn a_node_names_its_keys_ascending_and_answers_values_and_containers() {
    let doc = LoroDoc::new();
    let id = node!(&doc, None);
    let meta = doc.get_tree("t").get_meta(id).expect("meta");
    meta.insert("zeta", 1_i64).expect("set");
    meta.insert("alpha", "x").expect("set");
    let text = meta.insert_container("body", LoroText::new()).expect("text");
    text.insert(0, "hi").expect("text");
    let list = meta.insert_container("pins", LoroMovableList::new()).expect("list");
    list.push("a").expect("push");
    let nested = meta.insert_container("map", LoroMap::new()).expect("map");
    nested.insert("k", true).expect("set");
    let root = tree(&doc, "t").expect("a tree").roots()[0];
    assert_eq!(
        tree(&doc, "t").expect("a tree").keys(root),
        vec!["alpha", "body", "map", "pins", "zeta"]
    );
    assert_eq!(
        tree(&doc, "t").expect("a tree").entry(root, "zeta"),
        Some(Entry::Value(Value::Number(1.0)))
    );
    assert_eq!(
        tree(&doc, "t").expect("a tree").entry(root, "body"),
        Some(Entry::Container { kind: ContainerKind::Text, value: Value::String("hi".into()) })
    );
    assert_eq!(
        tree(&doc, "t").expect("a tree").entry(root, "pins"),
        Some(Entry::Container {
            kind: ContainerKind::MovableList,
            value: Value::Seq(vec![Value::String("a".into())])
        })
    );
    assert_eq!(
        tree(&doc, "t").expect("a tree").entry(root, "map"),
        Some(Entry::Container {
            kind: ContainerKind::Map,
            value: Value::Map(vec![("k".into(), Value::Bool(true))])
        })
    );
    assert_eq!(tree(&doc, "t").expect("a tree").entry(root, "absent"), None);
}

#[test]
fn a_plain_list_and_a_tree_are_their_own_kinds() {
    let doc = LoroDoc::new();
    let id = node!(&doc, None);
    let meta = doc.get_tree("t").get_meta(id).expect("meta");
    meta.insert_container("list", loro::LoroList::new()).expect("list");
    meta.insert_container("tree", loro::LoroTree::new()).expect("tree");
    let root = tree(&doc, "t").expect("a tree").roots()[0];
    assert!(matches!(
        tree(&doc, "t").expect("a tree").entry(root, "list"),
        Some(Entry::Container { kind: ContainerKind::List, .. })
    ));
    assert!(matches!(
        tree(&doc, "t").expect("a tree").entry(root, "tree"),
        Some(Entry::Container { kind: ContainerKind::Tree, .. })
    ));
}

#[test]
fn a_path_into_the_record_is_peeked_without_registering_what_is_absent() {
    let doc = LoroDoc::new();
    doc.get_map("outer").insert("k", 1_i64).expect("set");
    doc.commit();
    assert_eq!(peek(&doc, "outer/k"), Some(Entry::Value(Value::Number(1.0))));
    assert!(matches!(peek(&doc, "outer"), Some(Entry::Container { kind: ContainerKind::Map, .. })));
    assert_eq!(peek(&doc, "missing"), None);
    assert_eq!(peek(&doc, "outer/none"), None);
    let Value::Map(roots) = deep_value(&doc) else { panic!("a map") };
    assert!(roots.iter().all(|(key, _)| key != "missing"));
}

#[test]
fn reading_a_tree_the_record_lacks_leaves_its_bytes_and_value_as_they_were() {
    let elsewhere = LoroDoc::new();
    node!(&elsewhere, None);
    let node = tree(&elsewhere, "t").expect("a tree").roots()[0];
    let doc = LoroDoc::new();
    doc.get_map("outer").insert("k", 1_i64).expect("set");
    doc.get_map("t").insert("k", 2_i64).expect("a map named as the tree is");
    doc.commit();
    let bytes = doc.export(loro::ExportMode::Snapshot).expect("a snapshot");
    let value = deep_value(&doc);
    let _ = node;
    for name in ["absent", "t"] {
        assert!(tree(&doc, name).is_none(), "{name} is no tree the record holds");
    }
    doc.commit();
    assert_eq!(doc.export(loro::ExportMode::Snapshot).expect("a snapshot"), bytes);
    assert_eq!(deep_value(&doc), value);
}

#[test]
fn a_node_is_live_until_a_delete_takes_it_or_a_node_above_it() {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).expect("a peer");
    let gone = node!(&doc, None);
    let below = node!(&doc, Some(gone));
    let kept = node!(&doc, None);
    doc.get_tree("t").delete(gone).expect("a delete");
    let held = tree(&doc, "t").expect("a tree");
    let id = |n: TreeID| NodeId::parse(&format!("{}@{}", n.counter, n.peer)).expect("an id");
    assert!(held.is_live(id(kept)));
    assert!(!held.is_live(id(gone)), "deleted");
    assert!(!held.is_live(id(below)), "below a deleted node");
    assert!(!held.is_live(NodeId::parse("99@1").expect("an id")), "never held");
    assert_eq!(held.parent(id(below)), Some(id(gone)), "a deleted node keeps its parent");
    assert_eq!(held.parent(id(kept)), None);
    assert_eq!(NodeId::parse("0@1@2"), None);
}
