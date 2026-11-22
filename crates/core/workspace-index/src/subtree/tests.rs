use super::*;
use crate::test_record::tree_of;
use crate::test_record::{ID_A, ID_B, ID_C, add_node, document_meta, meta_of, writable};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{Entry, LoroDoc, LoroMap, LoroText};
use whiteboard_model::Value;

fn held(record: &WorkspaceRecord, document_id: &str, key: &str) -> Option<Entry> {
    let walked = record.document_node(document_id)?;
    tree_of(record.doc()).entry(walked.id, key)
}

#[test]
fn only_a_declared_content_key_held_as_its_own_kind_travels() {
    assert!(travels("body", Some(ContainerKind::Text)));
    assert!(!travels("body", Some(ContainerKind::Map)));
    assert!(!travels("body", None));
    assert!(travels("nodes", Some(ContainerKind::Map)));
    assert!(!travels("nodes", Some(ContainerKind::Text)));
    assert!(!travels("nodes", None));
    assert!(travels("anything", None));
    assert!(travels("anything", Some(ContainerKind::List)));
    assert!(travels("segment", None));
}

#[test]
fn an_exported_subtree_comes_back_with_its_content_and_its_children_in_order() {
    let doc = LoroDoc::new();
    let top = add_node(&doc, None, &document_meta(ID_A, "a"));
    let meta = meta_of(&doc, top);
    meta.insert_container("body", LoroText::new()).expect("body").insert(0, "hello").expect("text");
    let nodes = meta.insert_container("nodes", LoroMap::new()).expect("nodes");
    nodes.insert("n1", "one").expect("set");
    meta.insert("kind", "spatial").expect("set");
    add_node(&doc, Some(top), &document_meta(ID_B, "first"));
    add_node(&doc, Some(top), &document_meta(ID_C, "second"));
    let record = writable(&doc);
    let bytes = export_subtree_at(&record, "a").expect("exported").expect("something there");
    assert_eq!(export_subtree_at(&record, "nothing"), Ok(None));
    let target = writable(&LoroDoc::new());
    let placed = import_subtree(&target, &bytes, None).expect("placed");
    assert_eq!(placed.as_deref(), Some(ID_A));
    let paths: Vec<_> = target.index_nodes().into_iter().map(|n| n.path).collect();
    assert_eq!(paths, vec!["a", "a/first", "a/second"]);
    assert_eq!(
        held(&target, ID_A, "body"),
        Some(Entry::Container { kind: ContainerKind::Text, value: Value::String("hello".into()) })
    );
    assert_eq!(held(&target, ID_A, "nodes"), held(&record, ID_A, "nodes"));
    let walked = target.document_node(ID_A).expect("the document");
    assert_eq!(
        tree_of(target.doc()).keys(walked.id),
        vec![
            "body",
            "canvas",
            "core",
            "document",
            "documentId",
            "edgeLocks",
            "edges",
            "facets",
            "kind",
            "lines",
            "nodeLocks",
            "nodes",
            "proposals",
            "segment",
            "threads",
            "trust"
        ],
        "the containers the source lacked are attached, as a created document holds them"
    );
}

#[test]
fn a_content_key_held_as_the_wrong_kind_is_left_behind_and_attached_fresh() {
    let doc = LoroDoc::new();
    let top = add_node(&doc, None, &document_meta(ID_A, "a"));
    let meta = meta_of(&doc, top);
    meta.insert("body", "a scalar where a text belongs").expect("set");
    meta.insert_container("nodes", LoroText::new()).expect("a text where a map belongs");
    meta.insert("extra", "kept").expect("set");
    let record = writable(&doc);
    let bytes = export_subtree_at(&record, "a").expect("exported").expect("something");
    let target = writable(&LoroDoc::new());
    import_subtree(&target, &bytes, None).expect("placed");
    assert!(matches!(
        held(&target, ID_A, "body"),
        Some(Entry::Container { kind: ContainerKind::Text, .. })
    ));
    assert!(matches!(
        held(&target, ID_A, "nodes"),
        Some(Entry::Container { kind: ContainerKind::Map, .. })
    ));
    assert_eq!(held(&target, ID_A, "extra"), Some(Entry::Value(Value::String("kept".into()))));
}

#[test]
fn a_folder_exports_without_attaching_containers() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &[("segment", "f".to_owned())]);
    let record = writable(&doc);
    let bytes = export_subtree_at(&record, "f").expect("exported").expect("something");
    let copy = whiteboard_crdt::import_bytes(&bytes).expect("a document");
    let held = tree_of(&copy);
    let root = held.roots()[0];
    assert_eq!(held.keys(root), vec!["segment"]);
}

#[test]
fn an_import_goes_under_the_folders_it_names_and_refuses_what_is_not_a_document() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "a"));
    let record = writable(&doc);
    let bytes = export_subtree_at(&record, "a").expect("exported").expect("something");
    let target = writable(&LoroDoc::new());
    assert_eq!(
        import_subtree(&target, &bytes, Some("x/y")).expect("placed").as_deref(),
        Some(ID_A)
    );
    let paths: Vec<_> = target.index_nodes().into_iter().map(|n| n.path).collect();
    assert_eq!(paths, vec!["x", "x/y", "x/y/a"]);

    let folders = LoroDoc::new();
    add_node(&folders, None, &[("segment", "f".to_owned())]);
    let folder_bytes =
        export_subtree_at(&writable(&folders), "f").expect("exported").expect("something");
    let untouched = writable(&LoroDoc::new());
    assert_eq!(import_subtree(&untouched, &folder_bytes, Some("p")), Ok(None));
    assert!(untouched.index_nodes().is_empty(), "nothing is written for what holds no document");
    let empty = whiteboard_crdt::LoroDoc::new();
    let empty_bytes = crate::test_record::snapshot(&empty);
    assert_eq!(import_subtree(&untouched, &empty_bytes, None), Ok(None));
    assert!(matches!(import_subtree(&untouched, b"garbage", None), Err(PlaceError::Unreadable(_))));
}

#[test]
fn a_placement_error_converts_from_a_refused_write() {
    let refused = WriteError("loro".to_owned());
    assert_eq!(PlaceError::from(refused.clone()), PlaceError::Refused(refused));
}
