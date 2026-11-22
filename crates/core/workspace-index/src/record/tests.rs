use super::*;
use crate::test_record::{ID_A, ID_B, ID_C, add_node, document_meta, meta_of, snapshot};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{LoroList, LoroMap, LoroMovableList, LoroText};

fn open(doc: &LoroDoc) -> WorkspaceRecord {
    WorkspaceRecord::open(&snapshot(doc)).expect("a snapshot opens")
}

fn named_folder(segment: &str, name: Option<&str>) -> Vec<(&'static str, String)> {
    let mut meta = vec![("segment", segment.to_owned())];
    if let Some(name) = name {
        meta.push(("name", name.to_owned()));
    }
    meta
}

#[test]
fn bytes_that_are_not_a_record_do_not_open() {
    assert!(WorkspaceRecord::open(b"garbage").is_err());
}

#[test]
fn a_document_that_follows_another_at_its_path_is_shadowed() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "same"));
    add_node(&doc, None, &document_meta(ID_B, "same"));
    add_node(&doc, None, &document_meta(ID_C, "other"));
    let found = open(&doc).documents();
    let shadowed: Vec<Option<bool>> = found.iter().map(|f| f.shadowed).collect();
    assert_eq!(shadowed, vec![None, Some(true), None]);
    assert_eq!(found[0].document_id, ID_A);
    assert_eq!(found[1].path, "same");
}

#[test]
fn a_document_lists_what_its_meta_records() {
    let doc = LoroDoc::new();
    let node = add_node(&doc, None, &document_meta(ID_A, "a"));
    let meta = meta_of(&doc, node);
    meta.insert("name", "Plan").expect("set");
    meta.insert("createdAt", 1_i64).expect("set");
    meta.insert("updatedAt", 2_i64).expect("set");
    let found = open(&doc).documents();
    assert_eq!(found.len(), 1);
    let first = &found[0];
    assert_eq!(first.kind.as_deref(), Some("markdown"));
    assert_eq!(first.name.as_deref(), Some("Plan"));
    assert_eq!((first.created_at, first.updated_at), (Some(1.0), Some(2.0)));
    assert_eq!(first.content_digest, "f6bbc27f5a56d1e7");
}

#[test]
fn folders_are_not_documents() {
    let doc = LoroDoc::new();
    let folder = add_node(&doc, None, &named_folder("a", None));
    add_node(&doc, Some(folder), &document_meta(ID_A, "b"));
    let found = open(&doc).documents();
    assert_eq!(found.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["a/b"]);
}

#[test]
fn the_digest_names_the_content_the_node_holds() {
    let doc = LoroDoc::new();
    let node = add_node(&doc, None, &document_meta(ID_A, "a"));
    let meta = meta_of(&doc, node);
    let body = meta.insert_container("body", LoroText::new()).expect("a container");
    body.insert(0, "hello").expect("text");
    let nodes = meta.insert_container("nodes", LoroMap::new()).expect("a container");
    nodes.insert("n", 1_i64).expect("a value");
    meta.insert("unrelated", "x").expect("set");
    let expected = content_digest_of(&[
        ("nodes".to_owned(), Value::Map(vec![("n".to_owned(), Value::Number(1.0))])),
        ("body".to_owned(), Value::String("hello".to_owned())),
    ]);
    assert_eq!(open(&doc).documents()[0].content_digest, expected);
}

#[test]
fn each_content_container_moves_the_digest_and_a_stored_value_counts() {
    let mut seen = Vec::new();
    for key in CONTENT_KEYS {
        let doc = LoroDoc::new();
        let node = add_node(&doc, None, &document_meta(ID_A, "a"));
        meta_of(&doc, node).insert(key, 7_i64).expect("set");
        let digest = open(&doc).documents()[0].content_digest.clone();
        assert_eq!(digest, content_digest_of(&[(key.to_owned(), Value::Number(7.0))]), "{key}");
        seen.push(digest);
    }
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), CONTENT_KEYS.len());
}

#[test]
fn a_document_is_found_by_the_first_node_in_tree_order_carrying_its_id() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "same"));
    add_node(&doc, None, &document_meta(ID_B, "same"));
    add_node(&doc, None, &document_meta(ID_B, "again"));
    let record = open(&doc);
    let found = record.document_by_id(ID_B).expect("found");
    assert_eq!((found.path.as_str(), found.shadowed), ("same", None));
    assert!(record.document_by_id(ID_C).is_none());
    assert!(record.document_by_id("").is_none());
}

#[test]
fn a_folder_shows_the_first_name_given_at_its_path() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &named_folder("a", None));
    add_node(&doc, None, &named_folder("a", Some("Second")));
    add_node(&doc, None, &named_folder("a", Some("Third")));
    add_node(&doc, None, &named_folder("b", None));
    add_node(&doc, None, &named_folder("c", Some("C")));
    add_node(&doc, None, &document_meta(ID_A, "d"));
    assert_eq!(
        open(&doc).folder_names(),
        vec![("a".to_owned(), "Second".to_owned()), ("c".to_owned(), "C".to_owned())]
    );
}

#[test]
fn pinned_ids_come_in_pin_order_from_a_movable_list_only() {
    let doc = LoroDoc::new();
    let pinned = doc
        .get_map("workspaceMeta")
        .insert_container("pinned", LoroMovableList::new())
        .expect("a list");
    pinned.push(ID_B).expect("an id");
    pinned.push(7_i64).expect("a number");
    pinned.push(ID_A).expect("an id");
    assert_eq!(open(&doc).pinned(), vec![ID_B.to_owned(), ID_A.to_owned()]);
}

#[test]
fn a_record_without_a_movable_pinned_list_pins_nothing() {
    assert_eq!(open(&LoroDoc::new()).pinned(), Vec::<String>::new());
    let plain = LoroDoc::new();
    let list =
        plain.get_map("workspaceMeta").insert_container("pinned", loro_list()).expect("a list");
    list.push(ID_A).expect("an id");
    assert_eq!(open(&plain).pinned(), Vec::<String>::new());
    let other = LoroDoc::new();
    other.get_map("workspaceMeta").insert("pinned", ID_A).expect("a value");
    assert_eq!(open(&other).pinned(), Vec::<String>::new());
}

fn loro_list() -> LoroList {
    LoroList::new()
}

#[test]
fn trash_reads_through_the_record() {
    let doc = LoroDoc::new();
    assert!(open(&doc).trash().is_empty());
}

#[test]
fn nodes_lists_folders_and_documents_alike() {
    let doc = LoroDoc::new();
    let folder = add_node(&doc, None, &named_folder("a", None));
    add_node(&doc, Some(folder), &document_meta(ID_A, "b"));
    assert_eq!(open(&doc).nodes().len(), 2);
}
