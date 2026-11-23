use super::*;
use crate::test_record::{ID_A, ID_B, ID_C, add_node, document_meta, meta_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::LoroMap;

/// A record holding a folder `f` with a document under it, a document under a
/// node whose segment is a container, and a document at the root; every
/// node's map is then written past the returned version.
fn written_record() -> (LoroDoc, VersionVector) {
    let doc = LoroDoc::new();
    let folder = add_node(&doc, None, &[("segment", "f".to_owned())]);
    let a = add_node(&doc, Some(folder), &document_meta(ID_A, "a"));
    let unreadable = add_node(&doc, None, &[]);
    meta_of(&doc, unreadable).insert_container("segment", LoroMap::new()).expect("a map");
    let b = add_node(&doc, Some(unreadable), &document_meta(ID_B, "b"));
    let c = add_node(&doc, None, &document_meta(ID_C, "c"));
    doc.commit();
    let since = doc.oplog_vv();
    for node in [c, b, unreadable, a, folder] {
        meta_of(&doc, node).insert("updatedAt", 9).expect("a stamp");
    }
    doc.commit();
    (doc, since)
}

#[test]
fn a_document_written_with_a_path_is_touched_in_the_order_it_was_written() {
    let (doc, since) = written_record();
    assert_eq!(documents_touched_since(&doc, &since), vec![ID_C.to_owned(), ID_A.to_owned()]);
    assert_eq!(documents_touched_since(&doc, &doc.oplog_vv()), Vec::<String>::new());
}

#[test]
fn a_document_a_delete_took_is_not_touched() {
    let (doc, since) = written_record();
    let roots = doc.get_tree("tree").roots();
    doc.get_tree("tree").delete(roots[0]).expect("a delete");
    doc.commit();
    assert_eq!(documents_touched_since(&doc, &since), vec![ID_C.to_owned()]);
}

#[test]
fn a_record_without_a_tree_touches_nothing() {
    let doc = LoroDoc::new();
    let since = doc.oplog_vv();
    doc.get_map("tree").insert("documentId", ID_A).expect("a map root named like the tree");
    doc.commit();
    assert_eq!(documents_touched_since(&doc, &since), Vec::<String>::new());
}
