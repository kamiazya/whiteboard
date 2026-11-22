//! A tree and the roots beside it, read without writing to the record.

use loro::{LoroDoc, LoroMap, LoroMovableList, LoroText, TreeID};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{
    ContainerKind, Entry, deep_value, node_entry, node_keys, peek, tree_children, tree_roots,
};
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
    let roots = tree_roots(&doc, "t");
    assert_eq!(roots.len(), 2);
    let under = tree_children(&doc, "t", roots[0]);
    assert_eq!(under.len(), 2);
    assert_eq!(tree_children(&doc, "t", roots[1]).len(), 0);
    let expected = doc.get_tree("t").children(first).expect("children");
    assert_eq!(expected, vec![child_a, child_b]);
}

#[test]
fn a_deleted_node_is_not_listed() {
    let doc = LoroDoc::new();
    node!(&doc, None);
    let gone = node!(&doc, None);
    doc.get_tree("t").delete(gone).expect("deleted");
    assert_eq!(tree_roots(&doc, "t").len(), 1);
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
    let root = tree_roots(&doc, "t")[0];
    assert_eq!(node_keys(&doc, "t", root), vec!["alpha", "body", "map", "pins", "zeta"]);
    assert_eq!(node_entry(&doc, "t", root, "zeta"), Some(Entry::Value(Value::Number(1.0))));
    assert_eq!(
        node_entry(&doc, "t", root, "body"),
        Some(Entry::Container { kind: ContainerKind::Text, value: Value::String("hi".into()) })
    );
    assert_eq!(
        node_entry(&doc, "t", root, "pins"),
        Some(Entry::Container {
            kind: ContainerKind::MovableList,
            value: Value::Seq(vec![Value::String("a".into())])
        })
    );
    assert_eq!(
        node_entry(&doc, "t", root, "map"),
        Some(Entry::Container {
            kind: ContainerKind::Map,
            value: Value::Map(vec![("k".into(), Value::Bool(true))])
        })
    );
    assert_eq!(node_entry(&doc, "t", root, "absent"), None);
}

#[test]
fn a_plain_list_and_a_tree_are_their_own_kinds() {
    let doc = LoroDoc::new();
    let id = node!(&doc, None);
    let meta = doc.get_tree("t").get_meta(id).expect("meta");
    meta.insert_container("list", loro::LoroList::new()).expect("list");
    meta.insert_container("tree", loro::LoroTree::new()).expect("tree");
    let root = tree_roots(&doc, "t")[0];
    assert!(matches!(
        node_entry(&doc, "t", root, "list"),
        Some(Entry::Container { kind: ContainerKind::List, .. })
    ));
    assert!(matches!(
        node_entry(&doc, "t", root, "tree"),
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
