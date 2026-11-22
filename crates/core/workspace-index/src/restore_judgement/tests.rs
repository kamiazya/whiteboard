use super::*;
use crate::test_record::{ID_A, ID_B, ID_C, add_node, document_meta, meta_of, snapshot};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{LoroDoc, LoroText};

fn judged(build: impl FnOnce(&LoroDoc), parent: Option<&str>) -> Option<Placement> {
    let doc = LoroDoc::new();
    build(&doc);
    restorable_trash_documents(&snapshot(&doc), ID_A, parent).expect("the bytes are a record")
}

fn placed(documents: usize, folders: usize) -> Placement {
    Placement { documents, folders }
}

fn folder(segment: &str) -> Vec<(&'static str, String)> {
    vec![("segment", segment.to_owned())]
}

fn root(doc: &LoroDoc) -> whiteboard_crdt::TreeID {
    add_node(doc, None, &document_meta(ID_A, "a"))
}

#[test]
fn a_lone_document_places_one_document() {
    assert_eq!(
        judged(
            |doc| {
                root(doc);
            },
            None
        ),
        Some(placed(1, 0))
    );
}

#[test]
fn what_the_document_held_is_counted_with_it() {
    let build = |doc: &LoroDoc| {
        let top = root(doc);
        add_node(doc, Some(top), &document_meta(ID_B, "b"));
        let inner = add_node(doc, Some(top), &folder("x"));
        add_node(doc, Some(inner), &document_meta(ID_C, "c"));
    };
    assert_eq!(judged(build, None), Some(placed(3, 1)));
}

#[test]
fn the_folders_the_parent_path_needs_are_not_counted() {
    assert_eq!(
        judged(
            |doc| {
                root(doc);
            },
            Some("p/q")
        ),
        Some(placed(1, 0))
    );
    let build = |doc: &LoroDoc| {
        let top = root(doc);
        add_node(doc, Some(top), &folder("x"));
    };
    assert_eq!(judged(build, Some("p")), Some(placed(1, 1)));
}

#[test]
fn a_node_at_a_path_the_grammar_refuses_is_not_placed() {
    assert_eq!(
        judged(
            |doc| {
                root(doc);
            },
            Some("p/_bad")
        ),
        None
    );
    let build = |doc: &LoroDoc| {
        let top = root(doc);
        add_node(doc, Some(top), &document_meta(ID_B, "bad_segment"));
    };
    assert_eq!(judged(build, None), None);
    let long = "a".repeat(600);
    assert_eq!(
        judged(
            |doc| {
                root(doc);
            },
            Some(&format!("{long}/{long}"))
        ),
        None
    );
}

#[test]
fn a_folder_the_parent_path_names_is_held_to_the_grammar_too() {
    assert_eq!(
        judged(
            |doc| {
                root(doc);
            },
            Some("ok/-bad")
        ),
        None
    );
}

#[test]
fn a_name_is_bounded_in_utf16_units() {
    let named = |name: String| {
        move |doc: &LoroDoc| {
            let top = root(doc);
            meta_of(doc, top).insert("name", name).expect("set");
        }
    };
    assert_eq!(judged(named("x".repeat(200)), None), Some(placed(1, 0)));
    assert_eq!(judged(named("x".repeat(201)), None), None);
    assert_eq!(judged(named("\u{1f600}".repeat(100)), None), Some(placed(1, 0)));
    assert_eq!(judged(named("\u{1f600}".repeat(101)), None), None);
}

#[test]
fn bytes_for_another_document_place_nothing() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_B, "a"));
    assert_eq!(restorable_trash_documents(&snapshot(&doc), ID_A, None), Ok(None));
}

#[test]
fn a_root_that_is_not_a_document_places_nothing() {
    assert_eq!(
        judged(
            |doc| {
                add_node(doc, None, &folder("a"));
            },
            None
        ),
        None
    );
}

#[test]
fn a_record_with_no_tree_places_nothing() {
    assert_eq!(judged(|_| {}, None), None);
}

#[test]
fn an_unreadable_node_in_the_subtree_places_nothing() {
    let build = |doc: &LoroDoc| {
        let top = root(doc);
        let bad = add_node(doc, Some(top), &document_meta(ID_B, "b"));
        meta_of(doc, bad).insert_container("name", LoroText::new()).expect("a container");
    };
    assert_eq!(judged(build, None), None);
}

#[test]
fn bytes_that_are_not_a_record_are_refused_by_name() {
    assert!(restorable_trash_documents(b"", ID_A, None).is_err());
    assert!(restorable_trash_documents(b"AAAA", ID_A, None).is_err());
}
