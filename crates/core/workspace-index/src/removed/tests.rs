use super::{Placed, deepest_evacuee_above, is_above, masked};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::NodeId;

#[test]
fn a_path_is_above_only_its_own_descendants() {
    assert!(is_above("a", "a/b"));
    assert!(!is_above("a", "ab/c"));
    assert!(!is_above("a/b", "a/b"));
}

#[test]
fn only_a_tree_id_is_masked() {
    assert_eq!(masked("12@345").as_deref(), Some("12@*"));
    assert_eq!(masked("@345"), None);
    assert_eq!(masked("1@x"), None);
    assert_eq!(masked("1@"), None);
}

fn placed(path: &str, counter: i32) -> Placed {
    Placed {
        document_id: path.to_owned(),
        path: path.to_owned(),
        name: None,
        node: NodeId::parse(&format!("{counter}@1")).expect("a node"),
        above: None,
    }
}

#[test]
fn a_survivor_is_filed_under_the_first_evacuee_at_the_deepest_path_above_it() {
    let (top, deep, twin, aside) =
        (placed("a", 0), placed("a/b", 1), placed("a/b", 2), placed("c", 3));
    let evacuees = [&top, &deep, &twin, &aside];
    assert_eq!(deepest_evacuee_above(&evacuees, "a/b/s"), Some("a/b"));
    assert_eq!(deepest_evacuee_above(&[&deep, &top], "a/b/s"), Some("a/b"));
    assert_eq!(deepest_evacuee_above(&evacuees, "a/x"), Some("a"));
    assert_eq!(deepest_evacuee_above(&evacuees, "a"), None);
}
