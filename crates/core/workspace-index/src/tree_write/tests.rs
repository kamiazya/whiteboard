use super::*;
use crate::test_record::{ID_A, ID_B, ID_C, add_node, document_meta, writable};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{Entry, version_pairs};

fn folder(
    doc: &LoroDoc,
    parent: Option<whiteboard_crdt::TreeID>,
    segment: &str,
    name: Option<&str>,
) -> whiteboard_crdt::TreeID {
    let mut meta = vec![("segment", segment.to_owned())];
    if let Some(name) = name {
        meta.push(("name", name.to_owned()));
    }
    add_node(doc, parent, &meta)
}

fn paths(doc: &LoroDoc) -> Vec<String> {
    walk(doc).0.into_iter().map(|walked| walked.path).collect()
}

fn ops(doc: &LoroDoc) -> i64 {
    commit(doc);
    version_pairs(doc).iter().map(|(_, n)| *n).sum()
}

#[test]
fn a_pin_keeps_the_position_it_has_and_an_unpin_leaves_the_others_in_order() {
    let doc = LoroDoc::new();
    let record = writable(&doc);
    for id in [ID_A, ID_B, ID_C] {
        set_pinned(record.doc(), id, true).expect("pinned");
    }
    set_pinned(record.doc(), ID_A, true).expect("pinned again");
    assert_eq!(record.pinned(), vec![ID_A, ID_B, ID_C]);
    set_pinned(record.doc(), ID_B, false).expect("unpinned");
    assert_eq!(record.pinned(), vec![ID_A, ID_C]);
    let before = ops(record.doc());
    set_pinned(record.doc(), ID_B, false).expect("nothing to unpin");
    assert_eq!(ops(record.doc()), before);
}

#[test]
fn an_unpin_opens_the_list_a_record_never_held() {
    let record = writable(&LoroDoc::new());
    set_pinned(record.doc(), ID_A, false).expect("unpinned");
    assert!(matches!(
        whiteboard_crdt::peek(record.doc(), "workspaceMeta/pinned"),
        Some(Entry::Container { kind: whiteboard_crdt::ContainerKind::MovableList, .. })
    ));
    assert_eq!(ops(record.doc()), 1);
}

#[test]
fn a_chosen_name_is_marked_and_a_blank_or_absent_one_clears_both() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "a"));
    let record = writable(&doc);
    let id = record.document_node(ID_A).expect("the document").id;
    let read = |key| whiteboard_crdt::node_entry(record.doc(), "tree", id, key);
    set_document_name(record.doc(), id, Some("Plan")).expect("named");
    assert_eq!(
        (read("name"), read("nameChosen")),
        (Some(Entry::Value(Value::String("Plan".into()))), Some(Entry::Value(Value::Bool(true))))
    );
    set_document_name(record.doc(), id, Some(" \u{feff} ")).expect("cleared");
    assert_eq!((read("name"), read("nameChosen")), (None, None));
    set_document_name(record.doc(), id, Some("Again")).expect("named");
    set_document_name(record.doc(), id, None).expect("cleared");
    assert_eq!((read("name"), read("nameChosen")), (None, None));
}

#[test]
fn a_folder_is_named_on_its_first_node_and_cleared_on_every_node_at_the_path() {
    let doc = LoroDoc::new();
    folder(&doc, None, "twin", None);
    folder(&doc, None, "twin", Some("second"));
    folder(&doc, None, "twin", Some("third"));
    add_node(&doc, None, &document_meta(ID_A, "doc"));
    let record = writable(&doc);
    let names = || record.folder_names();
    assert_eq!(
        set_folder_name(record.doc(), "doc", Some("x")),
        Ok(false),
        "a document has no folder to name"
    );
    assert_eq!(set_folder_name(record.doc(), "nowhere", None), Ok(false));
    assert_eq!(set_folder_name(record.doc(), "twin", Some("  First  ")), Ok(true));
    assert_eq!(names(), vec![("twin".to_owned(), "First".to_owned())]);
    let nodes: Vec<_> = walk(record.doc()).0.into_iter().map(|w| w.read).collect();
    assert!(matches!(&nodes[0], NodeRead::Folder { name: Some(n), .. } if n == "First"));
    assert!(matches!(&nodes[1], NodeRead::Folder { name: Some(n), .. } if n == "second"));
    assert_eq!(set_folder_name(record.doc(), "twin", None), Ok(true));
    assert!(names().is_empty());
    let after: Vec<_> = walk(record.doc()).0.into_iter().map(|w| w.read).collect();
    assert!(after.iter().all(|read| !matches!(read, NodeRead::Folder { name: Some(_), .. })));
}

#[test]
fn a_clear_deletes_only_where_a_name_stands() {
    let doc = LoroDoc::new();
    folder(&doc, None, "a", Some("named"));
    folder(&doc, None, "b", None);
    let record = writable(&doc);
    let before = ops(record.doc());
    set_folder_name(record.doc(), "b", None).expect("cleared");
    assert_eq!(ops(record.doc()), before, "an unnamed folder is left alone");
    set_folder_name(record.doc(), "a", None).expect("cleared");
    assert_eq!(ops(record.doc()), before + 1);
}

#[test]
fn a_restored_folder_name_does_not_replace_a_name_given_since_or_a_refused_one() {
    let doc = LoroDoc::new();
    folder(&doc, None, "named", Some("Kept"));
    folder(&doc, None, "bare", None);
    folder(&doc, None, "other", None);
    folder(&doc, None, "slashed", None);
    let record = writable(&doc);
    let names = vec![
        ("named".to_owned(), "Row name".to_owned()),
        ("bare".to_owned(), "Back".to_owned()),
        ("slashed".to_owned(), "a/b".to_owned()),
        ("gone".to_owned(), "Nowhere".to_owned()),
        ("other".to_owned(), "  ".to_owned()),
    ];
    reapply_folder_names(record.doc(), &names).expect("reapplied");
    assert_eq!(
        record.folder_names(),
        vec![("named".to_owned(), "Kept".to_owned()), ("bare".to_owned(), "Back".to_owned())]
    );
}

#[test]
fn a_folder_path_is_made_only_where_no_node_stands_and_a_document_is_reused_as_a_parent() {
    let doc = LoroDoc::new();
    let parent = add_node(&doc, None, &document_meta(ID_A, "a"));
    add_node(&doc, Some(parent), &[("segment", "b".to_owned())]);
    let record = writable(&doc);
    assert_eq!(ensure_folder_path(record.doc(), &[]), Ok(None));
    let existing = ensure_folder_path(record.doc(), &["a", "b"]).expect("found").expect("a node");
    assert_eq!(paths(record.doc()), vec!["a", "a/b"]);
    let deeper =
        ensure_folder_path(record.doc(), &["a", "b", "c", "d"]).expect("made").expect("a node");
    assert_eq!(paths(record.doc()), vec!["a", "a/b", "a/b/c", "a/b/c/d"]);
    assert_ne!(existing, deeper);
    assert_eq!(whiteboard_crdt::tree_children(record.doc(), "tree", existing).len(), 1);
}

#[test]
fn a_document_promotes_the_folder_standing_at_its_path_and_a_document_owning_it_stops_it() {
    let doc = LoroDoc::new();
    let named = folder(&doc, None, "f", Some("Folder name"));
    add_node(&doc, Some(named), &document_meta(ID_B, "kid"));
    folder(&doc, None, "g", Some("Other folder"));
    add_node(&doc, None, &document_meta(ID_C, "owned"));
    let record = writable(&doc);
    let new = |document_id: &'static str, name| NewDocument {
        document_id,
        kind: "spatial",
        name,
        now_ms: 5.0,
    };
    create_document_at_path(record.doc(), "f", &new(ID_A, None)).expect("promoted");
    let promoted = record.placed_document(ID_A).expect("the document");
    assert_eq!(promoted.path, "f");
    assert_eq!(promoted.meta.name, None, "the folder's name was not chosen for the document");
    assert!(!promoted.meta.name_chosen);
    assert_eq!(
        record.document_node(ID_B).map(|w| w.path),
        Some("f/kid".to_owned()),
        "its children stay"
    );
    let before = ops(record.doc());
    create_document_at_path(record.doc(), "owned", &new("01ARZ3NDEKTSV4RRFFQ69G5FAZ", Some("x")))
        .expect("nothing written");
    assert_eq!(ops(record.doc()), before);
    create_document_at_path(record.doc(), "g", &new("01ARZ3NDEKTSV4RRFFQ69G5FAY", Some("Mine")))
        .expect("promoted");
    let mine = record.placed_document("01ARZ3NDEKTSV4RRFFQ69G5FAY").expect("the document");
    assert_eq!((mine.meta.name, mine.meta.name_chosen), (Some("Mine".to_owned()), true));
    assert_eq!((mine.meta.created_at, mine.meta.updated_at), (Some(5.0), Some(5.0)));
}

#[test]
fn a_new_document_holds_every_content_container_from_its_creation() {
    let record = writable(&LoroDoc::new());
    let new = NewDocument { document_id: ID_A, kind: "markdown", name: None, now_ms: 1.0 };
    create_document_at_path(record.doc(), "x", &new).expect("created");
    let id = record.document_node(ID_A).expect("the document").id;
    let keys = whiteboard_crdt::node_keys(record.doc(), "tree", id);
    for (key, kind) in CONTENT_CONTAINERS {
        assert!(keys.iter().any(|held| held == key), "{key}");
        assert!(matches!(
            whiteboard_crdt::node_entry(record.doc(), "tree", id, key),
            Some(Entry::Container { kind: held, .. }) if held == kind
        ));
    }
    assert_eq!(CONTENT_CONTAINERS.len(), 13);
}

#[test]
fn a_move_renames_the_segment_makes_the_folders_above_and_answers_false_for_nothing() {
    let doc = LoroDoc::new();
    let top = add_node(&doc, None, &document_meta(ID_A, "a"));
    add_node(&doc, Some(top), &document_meta(ID_B, "kid"));
    let record = writable(&doc);
    assert_eq!(move_node_to_path(record.doc(), "nothing", "x"), Ok(false));
    assert_eq!(move_node_to_path(record.doc(), "a", "new/place/b"), Ok(true));
    assert_eq!(paths(record.doc()), vec!["new", "new/place", "new/place/b", "new/place/b/kid"]);
    assert_eq!(move_node_to_path(record.doc(), "new/place/b", "root"), Ok(true));
    assert_eq!(paths(record.doc()), vec!["new", "new/place", "root", "root/kid"]);
}

#[test]
fn an_empty_folder_is_pruned_with_every_folder_it_leaves_empty() {
    let doc = LoroDoc::new();
    let one = folder(&doc, None, "one", None);
    let two = folder(&doc, Some(one), "two", None);
    folder(&doc, Some(two), "three", None);
    let keep = folder(&doc, None, "keep", None);
    add_node(&doc, Some(keep), &document_meta(ID_A, "d"));
    folder(&doc, None, "lone", None);
    let record = writable(&doc);
    prune_empty_folders(record.doc()).expect("pruned");
    assert_eq!(paths(record.doc()), vec!["keep", "keep/d"]);
}

#[test]
fn a_node_at_a_path_is_deleted_with_its_subtree_and_nothing_at_a_path_is_false() {
    let doc = LoroDoc::new();
    let top = add_node(&doc, None, &document_meta(ID_A, "a"));
    add_node(&doc, Some(top), &document_meta(ID_B, "b"));
    add_node(&doc, None, &document_meta(ID_C, "c"));
    let record = writable(&doc);
    assert_eq!(delete_node_at_path(record.doc(), "nothing"), Ok(false));
    assert_eq!(delete_node_at_path(record.doc(), "a"), Ok(true));
    assert_eq!(paths(record.doc()), vec!["c"]);
}

#[test]
fn a_trash_row_is_recorded_under_its_document_id_and_forgotten() {
    let record = writable(&LoroDoc::new());
    let row = Value::Map(vec![("k".to_owned(), Value::Number(1.0))]);
    record_trash_entry(record.doc(), ID_A, &row).expect("recorded");
    assert_eq!(
        whiteboard_crdt::peek(record.doc(), "trash/01ARZ3NDEKTSV4RRFFQ69G5FAA"),
        Some(Entry::Value(row))
    );
    forget_trash_entry(record.doc(), ID_A).expect("forgotten");
    assert_eq!(whiteboard_crdt::peek(record.doc(), "trash/01ARZ3NDEKTSV4RRFFQ69G5FAA"), None);
}

#[test]
fn only_what_a_copy_should_carry_travels_to_it() {
    assert!(travels_to_copy("body", false));
    assert!(travels_to_copy("threads", false));
    assert!(!travels_to_copy("threads", true));
    assert!(!travels_to_copy("proposals", true));
    assert!(travels_to_copy("proposals", false));
    assert!(travels_to_copy("nodes", true));
    assert!(!travels_to_copy("plane:main", false));
    for key in NODE_META_KEYS {
        assert!(!travels_to_copy(key, false), "{key}");
    }
}
