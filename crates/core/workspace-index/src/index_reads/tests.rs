use super::*;
use crate::test_record::{ID_A, ID_B, ID_C, add_node, document_meta, meta_of, snapshot};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{LoroDoc, LoroMovableList, loro_value};

fn open(doc: &LoroDoc) -> WorkspaceRecord {
    WorkspaceRecord::open(&snapshot(doc)).expect("a snapshot opens")
}

fn paths(entries: &[DocumentEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.path.as_str()).collect()
}

fn doc_of(documents: &[(&str, &str)]) -> LoroDoc {
    let doc = LoroDoc::new();
    for (id, segment) in documents {
        add_node(&doc, None, &document_meta(id, segment));
    }
    doc
}

#[test]
fn a_listing_is_in_path_order_not_tree_order() {
    let doc = doc_of(&[(ID_A, "b"), (ID_B, "a")]);
    let nested = add_node(&doc, None, &[("segment", "a-x".to_owned())]);
    add_node(&doc, Some(nested), &document_meta(ID_C, "c"));
    let listed = list_documents(&open(&doc)).expect("a listing");
    assert_eq!(paths(&listed), vec!["a", "a-x/c", "b"]);
}

#[test]
fn a_stored_time_no_date_holds_refuses_the_read() {
    let doc = doc_of(&[(ID_A, "a")]);
    let node = doc.get_tree("tree").roots().first().copied().expect("a root");
    meta_of(&doc, node).insert("createdAt", 9_000_000_000_000_000_i64).expect("set");
    let record = open(&doc);
    assert_eq!(list_documents(&record), Err(ReadError::InvalidTime(EntryError::InvalidTime)));
    assert_eq!(
        resolve_document(&record, "a"),
        Err(ReadError::InvalidTime(EntryError::InvalidTime))
    );
    assert_eq!(resolve_document_by_id(&record, ID_A), Err(EntryError::InvalidTime));
}

#[test]
fn a_path_is_resolved_or_absent_and_a_contested_one_is_refused() {
    let doc = doc_of(&[(ID_A, "a"), (ID_B, "twin"), (ID_C, "twin")]);
    let record = open(&doc);
    assert_eq!(
        resolve_document(&record, "a").expect("ok").map(|e| e.document_id),
        Some(ID_A.to_owned())
    );
    assert_eq!(resolve_document(&record, "missing"), Ok(None));
    assert_eq!(resolve_document(&record, "twin"), Err(ReadError::PathContested));
}

#[test]
fn a_document_is_resolved_by_its_id_or_absent() {
    let record = open(&doc_of(&[(ID_A, "a")]));
    assert_eq!(
        resolve_document_by_id(&record, ID_A).expect("ok").map(|e| e.path),
        Some("a".to_owned())
    );
    assert_eq!(resolve_document_by_id(&record, ID_B), Ok(None));
}

#[test]
fn pins_of_documents_that_are_gone_are_not_listed() {
    let doc = doc_of(&[(ID_A, "a"), (ID_B, "b")]);
    let pinned = doc
        .get_map("workspaceMeta")
        .insert_container("pinned", LoroMovableList::new())
        .expect("a list");
    pinned.push(ID_B).expect("id");
    pinned.push(ID_C).expect("id");
    pinned.push(ID_A).expect("id");
    assert_eq!(list_pinned_documents(&open(&doc)), vec![ID_B.to_owned(), ID_A.to_owned()]);
}

#[test]
fn folder_names_are_in_path_order() {
    let doc = LoroDoc::new();
    for (segment, name) in [("b", "B"), ("a", "A")] {
        add_node(&doc, None, &[("segment", segment.to_owned()), ("name", name.to_owned())]);
    }
    assert_eq!(
        list_folder_names(&open(&doc)),
        vec![("a".to_owned(), "A".to_owned()), ("b".to_owned(), "B".to_owned())]
    );
}

#[test]
fn the_trash_is_the_records_own_rows() {
    let doc = LoroDoc::new();
    let blob = loro_value!({ "algorithm": "sha-256", "digestHex": ("0".repeat(64)) });
    let row = loro_value!({ "documentId": ID_A, "path": "a", "deletedAt": 1, "blob": blob });
    doc.get_map("trash").insert(ID_A, row).expect("a row");
    assert_eq!(list_trash(&open(&doc)).len(), 1);
}
