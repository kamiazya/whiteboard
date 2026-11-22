use super::*;
use crate::test_record::{ID_A, add_node, document_meta, meta_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{LoroText, tree_roots};

fn first(doc: &LoroDoc) -> Option<NodeRead> {
    let root = *tree_roots(doc, WORKSPACE_TREE_KEY).first().expect("a root");
    read_node(doc, root)
}

/// A document node whose meta is the baseline plus `extra`, set after creation.
fn document_with(extra: &[(&str, &str)]) -> Option<NodeRead> {
    let doc = LoroDoc::new();
    let mut meta = document_meta(ID_A, "a");
    meta.extend(extra.iter().map(|(k, v)| (*k, (*v).to_owned())));
    add_node(&doc, None, &meta);
    first(&doc)
}

fn document_with_number(key: &str, number: f64) -> Option<NodeRead> {
    let doc = LoroDoc::new();
    let node = add_node(&doc, None, &document_meta(ID_A, "a"));
    meta_of(&doc, node).insert(key, number).expect("a number is set");
    first(&doc)
}

fn folder_with(meta: &[(&str, &str)]) -> Option<NodeRead> {
    let doc = LoroDoc::new();
    let meta: Vec<(&str, String)> = meta.iter().map(|(k, v)| (*k, (*v).to_owned())).collect();
    add_node(&doc, None, &meta);
    first(&doc)
}

#[test]
fn a_document_reads_as_what_its_meta_records() {
    let doc = LoroDoc::new();
    let node = add_node(&doc, None, &document_meta(ID_A, "a"));
    let meta = meta_of(&doc, node);
    meta.insert("name", "Plan").expect("set");
    meta.insert("nameChosen", true).expect("set");
    meta.insert("createdAt", 5_i64).expect("set");
    meta.insert("updatedAt", 6.0_f64).expect("set");
    assert_eq!(
        first(&doc),
        Some(NodeRead::Document(DocumentMeta {
            document_id: ID_A.to_owned(),
            segment: "a".to_owned(),
            kind: "markdown".to_owned(),
            name: Some("Plan".to_owned()),
            name_chosen: true,
            created_at: Some(5.0),
            updated_at: Some(6.0),
        }))
    );
}

#[test]
fn a_document_of_either_kind_reads_and_any_other_does_not() {
    assert!(matches!(document_with(&[]), Some(NodeRead::Document(_))));
    let doc = LoroDoc::new();
    let node = add_node(&doc, None, &document_meta(ID_A, "a"));
    meta_of(&doc, node).insert("kind", "spatial").expect("set");
    assert!(matches!(first(&doc), Some(NodeRead::Document(meta)) if meta.kind == "spatial"));
    assert_eq!(document_with(&[("kind", "canvas")]), None);
}

#[test]
fn a_document_id_that_is_not_a_canonical_ulid_leaves_the_node_unreadable() {
    assert_eq!(document_with(&[("documentId", "not-an-id")]), None);
    assert_eq!(document_with(&[("documentId", "81ARZ3NDEKTSV4RRFFQ69G5FAA")]), None);
}

#[test]
fn names_and_segments_are_present_or_absent_never_empty() {
    assert_eq!(document_with(&[("name", "")]), None);
    assert_eq!(document_with(&[("segment", "")]), None);
    assert!(matches!(document_with(&[("name", "x")]), Some(NodeRead::Document(_))));
}

#[test]
fn a_chosen_name_marker_is_true_or_absent() {
    let doc = LoroDoc::new();
    let node = add_node(&doc, None, &document_meta(ID_A, "a"));
    meta_of(&doc, node).insert("nameChosen", true).expect("set");
    assert!(matches!(first(&doc), Some(NodeRead::Document(_))));
    meta_of(&doc, node).insert("nameChosen", false).expect("set");
    assert_eq!(first(&doc), None);
}

#[test]
fn a_stamp_is_a_safe_integer() {
    assert!(matches!(document_with_number("createdAt", -5.0), Some(NodeRead::Document(_))));
    assert!(matches!(
        document_with_number("updatedAt", 9_007_199_254_740_991.0),
        Some(NodeRead::Document(_))
    ));
    assert_eq!(document_with_number("updatedAt", 9_007_199_254_740_992.0), None);
    assert_eq!(document_with_number("createdAt", 1.5), None);
    assert_eq!(document_with_number("createdAt", f64::NAN), None);
    assert_eq!(document_with_number("createdAt", f64::INFINITY), None);
}

#[test]
fn a_stamp_held_as_text_leaves_the_node_unreadable() {
    assert_eq!(document_with(&[("createdAt", "5")]), None);
    assert_eq!(document_with(&[("updatedAt", "5")]), None);
}

#[test]
fn a_meta_key_held_as_a_container_leaves_the_node_unreadable() {
    let doc = LoroDoc::new();
    let node = add_node(&doc, None, &document_meta(ID_A, "a"));
    meta_of(&doc, node).insert_container("name", LoroText::new()).expect("a container");
    assert_eq!(first(&doc), None);
}

#[test]
fn a_content_key_does_not_stop_a_document_reading() {
    let doc = LoroDoc::new();
    let node = add_node(&doc, None, &document_meta(ID_A, "a"));
    meta_of(&doc, node).insert_container("body", LoroText::new()).expect("a container");
    assert!(matches!(first(&doc), Some(NodeRead::Document(_))));
}

#[test]
fn a_folder_is_a_segment_and_an_optional_name_and_nothing_else() {
    assert_eq!(
        folder_with(&[("segment", "a")]),
        Some(NodeRead::Folder { segment: "a".to_owned(), name: None })
    );
    assert_eq!(
        folder_with(&[("segment", "a"), ("name", "Notes")]),
        Some(NodeRead::Folder { segment: "a".to_owned(), name: Some("Notes".to_owned()) })
    );
    assert_eq!(folder_with(&[("segment", "a"), ("extra", "x")]), None);
    assert_eq!(folder_with(&[("segment", "a"), ("kind", "spatial")]), None);
    assert_eq!(folder_with(&[("segment", "a"), ("name", "")]), None);
    assert_eq!(folder_with(&[("segment", "")]), None);
    assert_eq!(folder_with(&[("name", "x")]), None);
}

#[test]
fn a_node_with_a_broken_document_meta_is_not_read_as_a_folder() {
    assert_eq!(document_with(&[("kind", "canvas")]), None);
    assert_eq!(folder_with(&[]).map(|read| read.segment().to_owned()), None);
}

#[test]
fn a_nodes_segment_is_its_own_component() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "seg"));
    assert_eq!(first(&doc).map(|read| read.segment().to_owned()), Some("seg".to_owned()));
    assert_eq!(
        folder_with(&[("segment", "fold")]).map(|read| read.segment().to_owned()),
        Some("fold".to_owned())
    );
}
