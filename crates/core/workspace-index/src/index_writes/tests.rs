use super::*;
use crate::index_duplicate::{DuplicateDocument, duplicate_document};
use crate::test_record::{ID_A, ID_B, add_node, document_meta, id_of, meta_of, writable};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{LoroDoc, LoroText};

const WORKSPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW: f64 = 1_700_000_000_000.0;

#[derive(Default)]
struct Blobs {
    held: std::collections::BTreeMap<String, Vec<u8>>,
    puts: usize,
}

impl TrashBlobs for Blobs {
    fn put(&mut self, bytes: Vec<u8>) -> BlobRef {
        self.puts += 1;
        let digest_hex = format!("{:064}", self.puts);
        self.held.insert(digest_hex.clone(), bytes);
        BlobRef { algorithm: "sha-256".to_owned(), digest_hex }
    }

    fn get(&self, blob: &BlobRef) -> Option<Vec<u8>> {
        self.held.get(&blob.digest_hex).cloned()
    }

    fn delete(&mut self, blob: &BlobRef) {
        self.held.remove(&blob.digest_hex);
    }
}

fn minting(id: &str) -> impl FnMut() -> String {
    let id = id.to_owned();
    move || id.clone()
}

fn create<'a>(path: &'a str, name: Option<&'a str>) -> CreateDocument<'a> {
    CreateDocument { workspace_id: WORKSPACE, path, kind: "markdown", name }
}

fn documents_of(n: usize) -> LoroDoc {
    let doc = LoroDoc::new();
    for at in 0..n {
        add_node(&doc, None, &document_meta(&id_of(at), &format!("d{at}")));
    }
    doc
}

#[test]
fn a_created_document_is_stamped_with_the_clock_and_named_as_chosen() {
    let record = writable(&LoroDoc::new());
    let done = create_document(&record, &create("a/b", Some("Plan")), &mut minting(&id_of(7)), NOW)
        .expect("created");
    assert!(done.saved);
    assert_eq!(done.value.document_id, id_of(7));
    assert_eq!(done.value.path, "a/b");
    assert_eq!(done.value.name.as_deref(), Some("Plan"));
    assert_eq!(done.value.updated_at.as_deref(), Some("2023-11-14T22:13:20.000Z"));
    let placed = record.placed_document(&id_of(7)).expect("it is there");
    assert!(placed.meta.name_chosen);
    assert_eq!((placed.meta.created_at, placed.meta.updated_at), (Some(NOW), Some(NOW)));
    assert_eq!(placed.meta.kind, "markdown");
    let kinds: Vec<_> = record.index_nodes().iter().map(|n| (n.kind, n.path.clone())).collect();
    assert_eq!(
        kinds,
        vec![(NamedKind::Folder, "a".to_owned()), (NamedKind::Document, "a/b".to_owned())]
    );
}

#[test]
fn a_create_names_the_input_a_schema_refuses_and_mints_nothing() {
    let record = writable(&LoroDoc::new());
    let mut mint = || -> String { panic!("nothing is minted for a refused input") };
    assert_eq!(
        create_document(&record, &create("/bad", None), &mut mint, NOW),
        Err(IndexError::InvalidInput)
    );
}

#[test]
fn a_create_past_the_document_ceiling_is_refused_and_one_at_it_is_not() {
    let near = writable(&documents_of(1999));
    assert!(
        create_document(&near, &create("fresh", None), &mut minting(&id_of(9000)), NOW).is_ok()
    );
    let full = writable(&documents_of(2000));
    assert_eq!(
        create_document(&full, &create("fresh", None), &mut minting(&id_of(9000)), NOW),
        Err(IndexError::TooManyDocuments { documents: 2001 })
    );
}

#[test]
fn a_create_past_the_folder_ceiling_is_refused_for_the_folders_it_would_make() {
    let doc = LoroDoc::new();
    for at in 0..4000 {
        add_node(&doc, None, &[("segment", format!("f{at}"))]);
    }
    let record = writable(&doc);
    assert!(
        create_document(&record, &create("f1/inside", None), &mut minting(&id_of(1)), NOW).is_ok()
    );
    assert_eq!(
        create_document(&record, &create("new/inside", None), &mut minting(&id_of(2)), NOW),
        Err(IndexError::TooManyFolders { folders: 4001 })
    );
}

#[test]
fn a_named_create_at_a_path_a_document_owns_is_refused_with_the_id_minted() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "a"));
    let record = writable(&doc);
    let mut minted = 0;
    let mut mint = || {
        minted += 1;
        id_of(5)
    };
    assert_eq!(
        create_document(&record, &create("a", Some("Other")), &mut mint, NOW),
        Err(IndexError::PathTaken { workspace_id: WORKSPACE.to_owned(), path: "a".to_owned() })
    );
    assert_eq!(minted, 1);
    assert_eq!(record.documents().len(), 1);
}

#[test]
fn a_move_that_leaves_a_folder_empty_prunes_it() {
    let doc = LoroDoc::new();
    let folder = add_node(&doc, None, &[("segment", "f".to_owned())]);
    add_node(&doc, Some(folder), &document_meta(ID_A, "d"));
    let record = writable(&doc);
    let done =
        move_document(&record, &MoveDocument { workspace_id: WORKSPACE, from: "f/d", to: "d" })
            .expect("moved");
    assert!(done.saved);
    let paths: Vec<_> = record.index_nodes().into_iter().map(|n| n.path).collect();
    assert_eq!(paths, vec!["d".to_owned()]);
}

#[test]
fn a_move_names_what_refuses_it() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "a"));
    add_node(&doc, None, &document_meta(ID_B, "b"));
    let record = writable(&doc);
    let moved =
        |from, to| move_document(&record, &MoveDocument { workspace_id: WORKSPACE, from, to });
    assert_eq!(moved("", "c"), Err(IndexError::InvalidInput));
    assert_eq!(moved("a", "c d"), Err(IndexError::InvalidInput));
    assert_eq!(
        moved("nothing", "c"),
        Err(IndexError::DocumentNotFound {
            workspace_id: WORKSPACE.to_owned(),
            target: "nothing".to_owned()
        })
    );
    assert_eq!(
        moved("a", "a/inner"),
        Err(IndexError::MoveIntoSelf { from: "a".to_owned(), to: "a/inner".to_owned() })
    );
    assert_eq!(
        moved("a", "b"),
        Err(IndexError::PathTaken { workspace_id: WORKSPACE.to_owned(), path: "b".to_owned() })
    );
}

#[test]
fn a_rename_to_a_name_a_sibling_shows_is_refused_unless_the_name_is_unchanged() {
    let doc = LoroDoc::new();
    let first = add_node(&doc, None, &document_meta(ID_A, "a"));
    meta_of(&doc, first).insert("name", "Plan").expect("set");
    let second = add_node(&doc, None, &document_meta(ID_B, "b"));
    meta_of(&doc, second).insert("name", "Plan").expect("set");
    let record = writable(&doc);
    let rename = |document_id, name| {
        set_document_name_of(
            &record,
            &SetDocumentName { workspace_id: WORKSPACE, document_id, name },
        )
    };
    assert!(rename(ID_B, Some("Plan")).is_ok(), "a name the target already shows is no duplicate");
    assert!(matches!(rename(ID_B, Some(" plan ")), Ok(Outcome { saved: true, .. })));
    let third = id_of(3);
    let mut mint = minting(&third);
    create_document(&record, &create("c", Some("Third")), &mut mint, NOW).expect("created");
    assert!(matches!(rename(&third, Some("PLAN")), Err(IndexError::DisplayNameTaken(_))));
    assert!(rename(&third, Some("   ")).is_ok(), "a blank name clears");
    assert_eq!(record.placed_document(&third).map(|p| p.meta.name), Some(None));
    let long = "n".repeat(201);
    assert_eq!(rename(ID_A, Some(&long)), Err(IndexError::InvalidInput));
    assert_eq!(rename("short", None), Err(IndexError::InvalidInput));
    assert!(matches!(rename(&id_of(99), None), Err(IndexError::DocumentNotFound { .. })));
}

#[test]
fn a_pin_checks_the_document_before_the_id() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "a"));
    let record = writable(&doc);
    let pin = |document_id, pinned| {
        set_document_pinned(
            &record,
            &SetDocumentPinned { workspace_id: WORKSPACE, document_id, pinned },
        )
    };
    assert!(matches!(pin("not-an-id", true), Err(IndexError::DocumentNotFound { .. })));
    assert!(pin(ID_A, true).is_ok());
    assert_eq!(record.pinned(), vec![ID_A.to_owned()]);
    assert!(pin(ID_A, false).is_ok());
    assert!(record.pinned().is_empty());
}

#[test]
fn a_folder_is_named_trimmed_and_a_sibling_folder_may_not_show_the_name() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &[("segment", "a".to_owned()), ("name", "Taken".to_owned())]);
    add_node(&doc, None, &[("segment", "b".to_owned())]);
    add_node(&doc, None, &document_meta(ID_A, "d"));
    let record = writable(&doc);
    let name = |path, name| {
        set_folder_name_of(&record, &SetFolderName { workspace_id: WORKSPACE, path, name })
    };
    assert!(matches!(name("b", Some(" TAKEN ")), Err(IndexError::DisplayNameTaken(_))));
    assert_eq!(name("b", Some("a/b")), Err(IndexError::InvalidInput));
    assert_eq!(name("c d", Some("x")), Err(IndexError::InvalidInput));
    assert!(matches!(name("d", Some("x")), Err(IndexError::DocumentNotFound { .. })));
    assert!(name("b", Some("  Own  ")).is_ok());
    assert!(name("b", Some(" own ")).is_ok(), "the name the folder already shows is no duplicate");
    assert_eq!(
        record.folder_names(),
        vec![("a".to_owned(), "Taken".to_owned()), ("b".to_owned(), "own".to_owned())]
    );
    assert!(name("a", None).is_ok());
    assert_eq!(record.folder_names(), vec![("b".to_owned(), "own".to_owned())]);
}

fn trashed(record: &WorkspaceRecord, path: &str, blobs: &mut Blobs) {
    let done =
        delete_document(record, &DeleteDocument { workspace_id: WORKSPACE, path }, blobs, NOW)
            .expect("deleted");
    assert!(done.saved);
}

#[test]
fn a_delete_evacuates_a_document_and_records_the_names_of_the_folders_above_it() {
    let doc = LoroDoc::new();
    let one =
        add_node(&doc, None, &[("segment", "one".to_owned()), ("name", "Folder one".to_owned())]);
    let two = add_node(&doc, Some(one), &[("segment", "two".to_owned())]);
    add_node(&doc, Some(two), &document_meta(ID_A, "d"));
    add_node(&doc, None, &document_meta(ID_B, "keep"));
    let record = writable(&doc);
    let mut blobs = Blobs::default();
    trashed(&record, "one/two/d", &mut blobs);
    let rows = record.trash();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].document_id, ID_A);
    assert_eq!(rows[0].path, "one/two/d");
    assert_eq!(rows[0].deleted_at, 1_700_000_000_000);
    assert_eq!(rows[0].folder_names, Some(vec![("one".to_owned(), "Folder one".to_owned())]));
    assert_eq!(rows[0].name, None);
    assert_eq!(blobs.held.len(), 1);
    let nodes: Vec<_> = record.index_nodes().into_iter().map(|n| n.path).collect();
    assert_eq!(nodes, vec!["keep".to_owned()], "the folders it emptied went with it");
    let restored = restore_document(
        &record,
        &RestoreDocument { workspace_id: WORKSPACE, document_id: ID_A },
        &mut blobs,
    )
    .expect("restored");
    assert!(restored.saved);
    assert_eq!(restored.value.map(|p| p.path), Some("one/two/d".to_owned()));
    assert_eq!(record.folder_names(), vec![("one".to_owned(), "Folder one".to_owned())]);
    assert!(record.trash().is_empty());
    assert!(blobs.held.is_empty(), "the bytes went with the row");
}

#[test]
fn a_delete_of_a_folder_or_of_nothing_evacuates_nothing() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &[("segment", "empty".to_owned())]);
    let record = writable(&doc);
    let mut blobs = Blobs::default();
    let gone = delete_document(
        &record,
        &DeleteDocument { workspace_id: WORKSPACE, path: "nothing" },
        &mut blobs,
        NOW,
    )
    .expect("nothing to do");
    assert!(!gone.saved);
    let folder = delete_document(
        &record,
        &DeleteDocument { workspace_id: WORKSPACE, path: "empty" },
        &mut blobs,
        NOW,
    )
    .expect("deleted");
    assert!(folder.saved);
    assert_eq!((blobs.puts, record.trash().len(), record.index_nodes().len()), (0, 0, 0));
}

#[test]
fn a_delete_names_a_descendant_it_would_destroy() {
    let doc = LoroDoc::new();
    let parent = add_node(&doc, None, &document_meta(ID_A, "a"));
    add_node(&doc, Some(parent), &document_meta(ID_B, "b"));
    let record = writable(&doc);
    let refused = delete_document(
        &record,
        &DeleteDocument { workspace_id: WORKSPACE, path: "a" },
        &mut Blobs::default(),
        NOW,
    );
    assert_eq!(
        refused,
        Err(IndexError::HasDescendants {
            path: "a".to_owned(),
            detail: "Delete \"a/b\" and any others below it first.".to_owned()
        })
    );
    assert_eq!(record.trash().len(), 0);
}

#[test]
fn a_trash_row_keeps_at_most_the_nearest_256_folder_names() {
    let named: Vec<(String, String)> =
        (0..300).map(|depth| (vec!["f"; depth + 1].join("/"), format!("name {depth}"))).collect();
    let path = format!("{}/doc", vec!["f"; 300].join("/"));
    let above = named_folders_above(&named, &path);
    assert_eq!(above.len(), 256);
    assert_eq!(above[0].1, "name 44");
    assert_eq!(above[255].1, "name 299");
    assert_eq!(named_folders_above(&named[..2], "f/f/f/x"), named[..2].to_vec());
    assert_eq!(named_folders_above(&named, "top"), Vec::new());
    assert_eq!(named_folders_above(&named, "f"), Vec::new());
}

#[test]
fn a_purge_keeps_the_bytes_another_row_names_and_a_restore_needs_a_row_and_its_bytes() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "a"));
    add_node(&doc, None, &document_meta(ID_B, "b"));
    let record = writable(&doc);
    let mut blobs = Blobs::default();
    trashed(&record, "a", &mut blobs);
    trashed(&record, "b", &mut blobs);
    let one = blobs.held.keys().next().cloned().expect("a blob");
    for row in record.trash() {
        crate::tree_write::forget_trash_entry(record.doc(), &row.document_id).expect("forgotten");
    }
    let rows = vec![(ID_A, one.clone()), (ID_B, one.clone())];
    for (id, digest) in &rows {
        let value = whiteboard_model::Value::Map(vec![
            ("documentId".to_owned(), whiteboard_model::Value::String((*id).to_owned())),
            ("path".to_owned(), whiteboard_model::Value::String("p".to_owned())),
            ("deletedAt".to_owned(), whiteboard_model::Value::Number(1.0)),
            (
                "blob".to_owned(),
                whiteboard_model::Value::Map(vec![
                    ("algorithm".to_owned(), whiteboard_model::Value::String("sha-256".to_owned())),
                    ("digestHex".to_owned(), whiteboard_model::Value::String(digest.clone())),
                ]),
            ),
        ]);
        crate::tree_write::record_trash_entry(record.doc(), id, &value).expect("recorded");
    }
    let purge = |id: &str, blobs: &mut Blobs| {
        purge_trash_entry(
            &record,
            &PurgeTrashEntry { workspace_id: WORKSPACE, document_id: id },
            blobs,
        )
    };
    assert!(purge(ID_A, &mut blobs).expect("purged").value);
    assert!(blobs.held.contains_key(&one), "the other row still names it");
    assert!(purge(ID_B, &mut blobs).expect("purged").value);
    assert!(!blobs.held.contains_key(&one));
    let absent = purge(ID_B, &mut blobs).expect("nothing to purge");
    assert_eq!((absent.value, absent.saved), (false, false));
}

#[test]
fn a_restore_answers_nothing_for_a_row_a_live_document_or_a_missing_blob() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "a"));
    let record = writable(&doc);
    let mut blobs = Blobs::default();
    let restore = |blobs: &mut Blobs| {
        restore_document(
            &record,
            &RestoreDocument { workspace_id: WORKSPACE, document_id: ID_A },
            blobs,
        )
        .expect("answered")
    };
    let none = restore(&mut blobs);
    assert_eq!((none.value, none.saved), (None, false));
    trashed(&record, "a", &mut blobs);
    let digest = blobs.held.keys().next().cloned().expect("a blob");
    let bytes = blobs.held.remove(&digest).expect("bytes");
    let gone = restore(&mut blobs);
    assert_eq!((gone.value, gone.saved), (None, false));
    blobs.held.insert(digest, bytes);
    add_node(record.doc(), None, &document_meta(ID_A, "live"));
    let live = restore(&mut blobs);
    assert_eq!((live.value, live.saved), (None, false));
    assert_eq!(record.trash().len(), 1, "the row stays");
}

#[test]
fn a_restore_into_a_workspace_with_no_room_is_refused_and_keeps_the_row() {
    let doc = documents_of(2000);
    let record = writable(&doc);
    let mut blobs = Blobs::default();
    trashed(&record, "d0", &mut blobs);
    add_node(record.doc(), None, &document_meta(&id_of(5000), "fill"));
    let refused = restore_document(
        &record,
        &RestoreDocument { workspace_id: WORKSPACE, document_id: &id_of(0) },
        &mut blobs,
    );
    assert_eq!(refused, Err(IndexError::TooManyDocuments { documents: 2001 }));
    assert_eq!(record.trash().len(), 1);
    assert_eq!(blobs.held.len(), 1);
}

#[test]
fn a_restore_of_bytes_that_are_not_a_record_is_refused_not_answered_as_nothing() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "a"));
    let record = writable(&doc);
    let mut blobs = Blobs::default();
    trashed(&record, "a", &mut blobs);
    for bytes in blobs.held.values_mut() {
        *bytes = b"not a record".to_vec();
    }
    let refused = restore_document(
        &record,
        &RestoreDocument { workspace_id: WORKSPACE, document_id: ID_A },
        &mut blobs,
    );
    assert!(matches!(refused, Err(IndexError::UnreadableTrashBytes(_))));
}

#[test]
fn a_duplicate_copies_content_and_leaves_the_annotation_layer_when_asked() {
    let doc = LoroDoc::new();
    let node = add_node(&doc, None, &document_meta(ID_A, "a"));
    let meta = meta_of(&doc, node);
    meta.insert_container("body", LoroText::new()).expect("body").insert(0, "hello").expect("text");
    let threads =
        meta.insert_container("threads", whiteboard_crdt::LoroMap::new()).expect("threads");
    threads.insert("t1", "a thread").expect("set");
    let record = writable(&doc);
    let duplicate = |id: &str, path, without_annotations| {
        let input = DuplicateDocument { workspace_id: WORKSPACE, path, without_annotations };
        duplicate_document(&record, &input, &mut minting(id), NOW).expect("duplicated")
    };
    let whole = duplicate(&id_of(1), "a", false);
    assert_eq!(whole.value.path, "a-copy");
    assert_eq!(whole.value.name.as_deref(), Some("a (copy)"));
    let bare = duplicate(&id_of(2), "a", true);
    assert_eq!(bare.value.path, "a-copy-2");
    let content = |id: &str, key: &str| {
        let walked = record.document_node(id).expect("the document");
        whiteboard_crdt::node_entry(record.doc(), "tree", walked.id, key)
    };
    let held = |entry: Option<whiteboard_crdt::Entry>| match entry {
        Some(whiteboard_crdt::Entry::Container { value, .. }) => Some(value),
        _ => None,
    };
    let expected_body = Some(whiteboard_model::Value::String("hello".to_owned()));
    assert_eq!(held(content(&id_of(1), "body")), expected_body);
    assert_eq!(held(content(&id_of(2), "body")), expected_body);
    assert_eq!(
        held(content(&id_of(1), "threads")),
        Some(whiteboard_model::Value::Map(vec![(
            "t1".to_owned(),
            whiteboard_model::Value::String("a thread".to_owned())
        )]))
    );
    assert_eq!(held(content(&id_of(2), "threads")), Some(whiteboard_model::Value::Map(vec![])));
    assert_ne!(whole.value.content_digest, bare.value.content_digest);
    let placed = record.placed_document(&id_of(1)).expect("placed");
    assert_eq!(placed.meta.updated_at, Some(NOW));
}

#[test]
fn a_duplicate_is_refused_with_no_room_beside_the_source_or_in_the_workspace() {
    let doc = LoroDoc::new();
    let deep = add_node(&doc, None, &[("segment", "f".repeat(1018))]);
    add_node(&doc, Some(deep), &document_meta(ID_A, "x"));
    let record = writable(&doc);
    let path = format!("{}/x", "f".repeat(1018));
    let input =
        DuplicateDocument { workspace_id: WORKSPACE, path: &path, without_annotations: false };
    assert_eq!(
        duplicate_document(&record, &input, &mut minting(&id_of(1)), NOW),
        Err(IndexError::NoRoomForCopy { path: path.clone() })
    );
    let full = writable(&documents_of(2000));
    let input =
        DuplicateDocument { workspace_id: WORKSPACE, path: "d0", without_annotations: false };
    assert_eq!(
        duplicate_document(&full, &input, &mut minting(&id_of(1)), NOW),
        Err(IndexError::TooManyDocuments { documents: 2001 })
    );
    let bad = DuplicateDocument { workspace_id: "x", path: "d0", without_annotations: false };
    assert_eq!(
        duplicate_document(&full, &bad, &mut minting(&id_of(1)), NOW),
        Err(IndexError::InvalidInput)
    );
    let bad =
        DuplicateDocument { workspace_id: WORKSPACE, path: "/d0", without_annotations: false };
    assert_eq!(
        duplicate_document(&full, &bad, &mut minting(&id_of(1)), NOW),
        Err(IndexError::InvalidInput)
    );
}

#[test]
fn an_error_converts_from_what_a_write_refuses_with() {
    let write = whiteboard_crdt::WriteError("loro".to_owned());
    assert_eq!(IndexError::from(write.clone()), IndexError::Record(write));
    let taken = DisplayNameTaken {
        kind: NamedKind::Folder,
        path: "p".to_owned(),
        display_name: "n".to_owned(),
    };
    assert_eq!(IndexError::from(taken.clone()), IndexError::DisplayNameTaken(taken));
    assert_eq!(
        IndexError::from(crate::entry::EntryError::InvalidTime),
        IndexError::InvalidTime(crate::entry::EntryError::InvalidTime)
    );
}

#[test]
fn every_schema_checked_write_refuses_a_workspace_id_that_is_not_one() {
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "a"));
    add_node(&doc, None, &[("segment", "f".to_owned())]);
    let record = writable(&doc);
    let invalid = Err(IndexError::InvalidInput);
    assert_eq!(
        move_document(&record, &MoveDocument { workspace_id: "x", from: "a", to: "b" }),
        invalid
    );
    assert_eq!(
        set_document_name_of(
            &record,
            &SetDocumentName { workspace_id: "x", document_id: ID_A, name: None }
        ),
        invalid
    );
    assert_eq!(
        set_folder_name_of(&record, &SetFolderName { workspace_id: "x", path: "f", name: None }),
        invalid
    );
    assert_eq!(record.documents().len(), 1);
}

#[test]
fn a_create_stamped_with_a_time_no_date_holds_is_written_and_then_refused_as_an_entry() {
    let record = writable(&LoroDoc::new());
    let refused = create_document(&record, &create("a", None), &mut minting(&id_of(1)), 9.0e15);
    assert_eq!(refused, Err(IndexError::InvalidTime(crate::entry::EntryError::InvalidTime)));
}
