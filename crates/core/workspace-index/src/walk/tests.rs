use super::*;
use crate::test_record::{ID_A, ID_B, ID_C, add_node, document_meta, meta_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::LoroText;

fn folder(segment: &str) -> Vec<(&'static str, String)> {
    vec![("segment", segment.to_owned())]
}

fn paths(walked: &[Walked]) -> Vec<&str> {
    walked.iter().map(|w| w.path.as_str()).collect()
}

#[test]
fn nodes_come_in_tree_order_with_the_path_their_ancestors_give() {
    let doc = LoroDoc::new();
    let a = add_node(&doc, None, &folder("a"));
    let b = add_node(&doc, Some(a), &folder("b"));
    add_node(&doc, Some(b), &document_meta(ID_A, "deep"));
    add_node(&doc, Some(a), &document_meta(ID_B, "side"));
    add_node(&doc, None, &document_meta(ID_C, "z"));
    let (walked, skipped) = walk(&doc);
    assert_eq!(paths(&walked), vec!["a", "a/b", "a/b/deep", "a/side", "z"]);
    assert_eq!(skipped, 0);
}

#[test]
fn an_unreadable_node_is_skipped_with_everything_below_it() {
    let doc = LoroDoc::new();
    let bad = add_node(&doc, None, &document_meta(ID_A, "bad"));
    meta_of(&doc, bad).insert_container("name", LoroText::new()).expect("a container");
    add_node(&doc, Some(bad), &document_meta(ID_B, "child"));
    add_node(&doc, None, &document_meta(ID_C, "ok"));
    let (walked, skipped) = walk(&doc);
    assert_eq!(paths(&walked), vec!["ok"]);
    assert_eq!(skipped, 1);
}

#[test]
fn a_walk_under_nodes_places_their_paths_below_the_prefix() {
    let doc = LoroDoc::new();
    let a = add_node(&doc, None, &document_meta(ID_A, "a"));
    add_node(&doc, Some(a), &document_meta(ID_B, "b"));
    add_node(&doc, None, &document_meta(ID_C, "other"));
    let roots = whiteboard_crdt::tree_roots(&doc, WORKSPACE_TREE_KEY);
    let (walked, _) = walk_under(&doc, roots.into_iter().take(1).collect(), "p/q");
    assert_eq!(paths(&walked), vec!["p/q/a", "p/q/a/b"]);
}
