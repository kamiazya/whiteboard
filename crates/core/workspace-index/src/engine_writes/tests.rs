use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::WriteAnswer;

#[test]
fn the_listed_writers_are_the_ones_answered() {
    assert!(WORKSPACE_WRITERS.iter().all(|op| writer_of(*op).is_some()));
    assert!(writer_of(WriterName::WriteMarkdownBody).is_none());
}

#[test]
fn only_a_writer_of_the_planes_beside_the_tree_leaves_the_tree_unopened() {
    let beside = [
        WriterName::SetWorkspaceLastCompactedAt,
        WriterName::SetWorkspacePinned,
        WriterName::RecordTrashEntry,
        WriterName::ForgetTrashEntry,
    ];
    for op in WORKSPACE_WRITERS {
        let (_, opens_tree) = writer_of(*op).expect("a writer");
        assert_eq!(opens_tree, !beside.contains(op), "{op:?}");
    }
}

/// A `since` pair the TypeScript's `versionOfPairs` would hand loro unread: a
/// peer that is not plain decimal digits, or a counter outside `0..=i32::MAX`,
/// is not answered here, while a plain one is.
#[test]
fn a_since_pair_loro_would_not_read_is_not_answered() {
    let empty = LoroDoc::new().export(whiteboard_crdt::ExportMode::Snapshot).expect("bytes");
    let stamp = |peer: &str, counter: f64| {
        let pair = Value::Seq(vec![Value::String(peer.to_owned()), Value::Number(counter)]);
        let args = Value::Map(vec![("since".to_owned(), Value::Seq(vec![pair]))]);
        let write = Write { op: WriterName::StampEditedDocuments, args };
        write_workspace_batch(&empty, 1, &[write], WriteJudge::None, 0.0).is_some()
    };
    assert!(stamp("1", 0.0), "a plain pair");
    assert!(!stamp("+1", 0.0), "a signed peer");
    assert!(!stamp("1", -1.0), "a negative counter");
}

const HELD: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NEW: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

fn args(entries: &[(&str, Value)]) -> Value {
    Value::Map(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
}

fn s(text: &str) -> Value {
    Value::String(text.to_owned())
}

/// A record holding one markdown document, `HELD` at `d`.
fn record_holding_one() -> Vec<u8> {
    let empty = LoroDoc::new().export(whiteboard_crdt::ExportMode::Snapshot).expect("bytes");
    let create = Write {
        op: WriterName::CreateWorkspaceDocumentAtPath,
        args: args(&[("path", s("d")), ("documentId", s(HELD)), ("kind", s("markdown"))]),
    };
    let done = write_workspace_batch(&empty, 1, &[create], WriteJudge::None, 1.0).expect("created");
    done.doc.export(whiteboard_crdt::ExportMode::Snapshot).expect("bytes")
}

/// A standalone document, as the base64 a content writer is handed.
fn a_source() -> Value {
    let doc = LoroDoc::new();
    doc.get_text("body").insert(0, "# T").expect("a body");
    doc.commit();
    let bytes = doc.export(whiteboard_crdt::ExportMode::Snapshot).expect("bytes");
    s(&whiteboard_model::encoding::bytes_to_base64(&bytes))
}

/// Arguments the tree writers' types refuse: a required text missing, or a
/// field of the wrong type, each past every argument before it that holds.
fn tree_writer_declines() -> Vec<(WriterName, Value)> {
    use WriterName as W;
    let create = |extra: &[(&str, Value)]| {
        let mut entries = vec![("path", s("n")), ("documentId", s(NEW)), ("kind", s("markdown"))];
        entries.extend_from_slice(extra);
        args(&entries)
    };
    vec![
        (W::CreateWorkspaceDocumentAtPath, args(&[])),
        (W::CreateWorkspaceDocumentAtPath, create(&[("createdAt", s("1"))])),
        (W::CreateWorkspaceDocumentAtPath, create(&[("updatedAt", s("1"))])),
        (W::CreateWorkspaceDocumentAtPath, args(&[("path", s("n")), ("documentId", s(NEW))])),
        (W::CreateWorkspaceDocumentAtPath, create(&[("name", Value::Number(1.0))])),
        (W::CreateWorkspaceDocument, args(&[])),
        (W::MoveWorkspaceDocument, args(&[])),
        (
            W::MoveWorkspaceDocument,
            args(&[("documentId", s(HELD)), ("parentId", Value::Bool(true))]),
        ),
        (W::MoveWorkspaceNodeToPath, args(&[])),
        (W::MoveWorkspaceNodeToPath, args(&[("from", s("d"))])),
        (W::SetWorkspaceDocumentName, args(&[])),
        (
            W::SetWorkspaceDocumentName,
            args(&[("documentId", s(HELD)), ("name", Value::Bool(true))]),
        ),
        (W::SetWorkspaceFolderName, args(&[])),
        (W::SetWorkspaceFolderName, args(&[("path", s("f")), ("name", Value::Bool(true))])),
        (W::DeleteWorkspaceDocument, args(&[])),
        (W::DeleteWorkspaceNodeAtPath, args(&[])),
        (W::UpdateWorkspaceDocumentMeta, args(&[])),
        (W::UpdateWorkspaceDocumentMeta, args(&[("documentId", s(HELD))])),
        (W::ReapplyFolderNames, args(&[])),
        (W::ReapplyFolderNames, args(&[("names", Value::Seq(vec![args(&[])]))])),
        (W::ReapplyFolderNames, args(&[("names", Value::Seq(vec![args(&[("path", s("f"))])]))])),
    ]
}

/// Arguments the content writers and the planes' writers refuse.
fn other_writer_declines() -> Vec<(WriterName, Value)> {
    use WriterName as W;
    let content = |source: Value| args(&[("documentId", s(HELD)), ("source", source)]);
    let since = |pairs: Vec<Value>| args(&[("since", Value::Seq(pairs))]);
    let pair = Value::Seq(vec![Value::Number(1.0), Value::Number(0.0)]);
    let duplicate = |extra: &[(&str, Value)]| {
        let mut entries = vec![("sourceDocumentId", s(HELD)), ("documentId", s(NEW))];
        entries.extend_from_slice(extra);
        args(&entries)
    };
    let mut stamped = since(vec![]);
    if let Value::Map(entries) = &mut stamped {
        entries.push(("at".to_owned(), s("9")));
    }
    let mut written = content(a_source());
    if let Value::Map(entries) = &mut written {
        entries.push(("updatedAt".to_owned(), s("9")));
    }
    vec![
        (W::WriteWorkspaceDocumentContent, args(&[])),
        (W::WriteWorkspaceDocumentContent, args(&[("documentId", s(HELD))])),
        (W::SetWorkspaceDocumentName, Value::Seq(vec![])),
        (W::WriteWorkspaceDocumentContent, content(s("!!"))),
        (W::WriteWorkspaceDocumentContent, written),
        (W::WriteDocumentContentAndName, args(&[])),
        (W::WriteDocumentContentAndName, content(s("!!"))),
        (W::SeedNameFromTitle, args(&[])),
        (W::SeedNamesFromTitles, args(&[])),
        (W::StampEditedDocuments, args(&[])),
        (W::StampEditedDocuments, since(vec![s("1")])),
        (W::StampEditedDocuments, since(vec![pair])),
        (W::StampEditedDocuments, stamped),
        (W::DuplicateWorkspaceDocument, args(&[])),
        (W::DuplicateWorkspaceDocument, duplicate(&[])),
        (W::DuplicateWorkspaceDocument, args(&[("sourceDocumentId", s(HELD))])),
        (W::DuplicateWorkspaceDocument, duplicate(&[("path", s("c"))])),
        (
            W::DuplicateWorkspaceDocument,
            duplicate(&[("path", s("c")), ("name", s("C")), ("withoutAnnotations", s("yes"))]),
        ),
        (W::SetWorkspaceLastCompactedAt, args(&[])),
        (W::SetWorkspacePinned, args(&[])),
        (W::SetWorkspacePinned, args(&[("documentId", s(HELD))])),
        (W::RecordTrashEntry, args(&[])),
        (W::ForgetTrashEntry, args(&[])),
    ]
}

/// What a writer's TypeScript types refuse is left to the caller, never
/// answered: each case holds every argument before the one it breaks.
#[test]
fn arguments_a_writer_types_refuse_are_not_answered() {
    let before = record_holding_one();
    for (op, args) in tree_writer_declines().into_iter().chain(other_writer_declines()) {
        let write = Write { op, args: args.clone() };
        let done = write_workspace_batch(&before, 1, &[write], WriteJudge::None, 2.0);
        assert!(done.is_none(), "{op:?} {args:?}");
    }
}

/// A pinned list stored as a container the engine opens as none of its kinds
/// is left to the caller.
#[test]
fn a_pin_over_a_container_of_another_kind_is_not_answered() {
    let doc = LoroDoc::new();
    let meta = doc.get_map(crate::record::WORKSPACE_META_KEY);
    meta.insert_container(crate::record::PINNED_KEY, whiteboard_crdt::LoroList::new())
        .expect("a list");
    doc.commit();
    let before = doc.export(whiteboard_crdt::ExportMode::Snapshot).expect("bytes");
    let args = args(&[("documentId", s(HELD)), ("pinned", Value::Bool(true))]);
    let write = Write { op: WriterName::SetWorkspacePinned, args };
    assert!(write_workspace_batch(&before, 1, &[write], WriteJudge::None, 2.0).is_none());
}

/// The `updatedAt` the record holds for `HELD`.
fn held_updated_at(record: &LoroDoc) -> Option<f64> {
    let documents = crate::record::WorkspaceRecord::over(record).documents();
    documents.into_iter().find(|found| found.document_id == HELD).and_then(|found| found.updated_at)
}

/// `clearRootContainer` answers whether a text held anything, so a content
/// write whose source has no body moves the clock over a body holding text,
/// and leaves it over one already empty (`content-sync.ts`).
#[test]
fn clearing_a_body_moves_the_clock_only_when_it_held_text() {
    let write = |before: &[u8], source: Value, at: f64| {
        let args =
            args(&[("documentId", s(HELD)), ("source", source), ("updatedAt", Value::Number(at))]);
        let write = Write { op: WriterName::WriteWorkspaceDocumentContent, args };
        write_workspace_batch(before, 1, &[write], WriteJudge::None, 0.0).expect("answered").doc
    };
    let none = LoroDoc::new().export(whiteboard_crdt::ExportMode::Snapshot).expect("bytes");
    let none = s(&whiteboard_model::encoding::bytes_to_base64(&none));
    let snapshot =
        |doc: &LoroDoc| doc.export(whiteboard_crdt::ExportMode::Snapshot).expect("bytes");
    let bodied = write(&record_holding_one(), a_source(), 5.0);
    assert_eq!(held_updated_at(&bodied), Some(5.0));
    let cleared = write(&snapshot(&bodied), none.clone(), 9.0);
    assert_eq!(held_updated_at(&cleared), Some(9.0), "a body holding text cleared");
    let again = write(&snapshot(&cleared), none, 11.0);
    assert_eq!(held_updated_at(&again), Some(9.0), "an empty body cleared again");
}

/// A trash row the strict schema refuses throws its `ZodError`, as
/// `trashEntrySchema.parse` does: a folder-name row that is no object or lacks
/// a key, and a blob lacking one; the row they break is recorded whole.
#[test]
fn a_trash_row_the_schema_refuses_throws_its_zod_error() {
    let blob = |entries: &[(&str, Value)]| args(entries);
    let digest = ("digestHex", s(&"a".repeat(64)));
    let algorithm = ("algorithm", s("sha-256"));
    let row = |names: Value, blob: Value| {
        let entry = args(&[
            ("documentId", s(HELD)),
            ("path", s("d")),
            ("folderNames", Value::Seq(vec![names])),
            ("deletedAt", Value::Number(1.0)),
            ("blob", blob),
        ]);
        let write = Write { op: WriterName::RecordTrashEntry, args: args(&[("entry", entry)]) };
        let done = write_workspace_batch(&record_holding_one(), 1, &[write], WriteJudge::None, 2.0);
        done.expect("answered").answer
    };
    let names = args(&[("path", s("p")), ("name", s("N"))]);
    let whole = blob(&[algorithm.clone(), digest.clone()]);
    assert!(matches!(row(names.clone(), whole.clone()), WriteAnswer::Applied(_)), "the whole row");
    let refused = [
        row(s("p"), whole.clone()),
        row(args(&[("name", s("N"))]), whole.clone()),
        row(args(&[("path", s("p"))]), whole),
        row(names.clone(), blob(&[algorithm])),
        row(names, blob(&[digest])),
    ];
    for answer in refused {
        assert!(matches!(answer, WriteAnswer::Thrown("ZodError")), "{answer:?}");
    }
}

/// A name the seed gave from a heading still being typed is taken back when
/// the finished heading is what a sibling already shows (`nameToSeed`).
#[test]
fn a_seeded_name_a_sibling_shows_is_taken_back() {
    let content = |body: &str| {
        let doc = LoroDoc::new();
        doc.get_text("body").insert(0, body).expect("a body");
        doc.commit();
        let bytes = doc.export(whiteboard_crdt::ExportMode::Snapshot).expect("bytes");
        let source = s(&whiteboard_model::encoding::bytes_to_base64(&bytes));
        let args = args(&[("documentId", s(HELD)), ("source", source)]);
        Write { op: WriterName::WriteDocumentContentAndName, args }
    };
    let create = |path: &str, id: &str| Write {
        op: WriterName::CreateWorkspaceDocumentAtPath,
        args: args(&[("path", s(path)), ("documentId", s(id)), ("kind", s("markdown"))]),
    };
    let empty = LoroDoc::new().export(whiteboard_crdt::ExportMode::Snapshot).expect("bytes");
    let name = |batch: &[Write]| {
        let done =
            write_workspace_batch(&empty, 1, batch, WriteJudge::None, 1.0).expect("answered");
        let documents = crate::record::WorkspaceRecord::over(&done.doc).documents();
        documents.into_iter().find(|found| found.document_id == HELD).and_then(|found| found.name)
    };
    let typing = [create("untitled", HELD), create("plan", NEW), content("# P")];
    assert_eq!(name(&typing).as_deref(), Some("P"), "the heading being typed");
    let finished =
        [create("untitled", HELD), create("plan", NEW), content("# P"), content("# Plan")];
    assert_eq!(name(&finished), None, "the finished heading a sibling shows");
}

/// A node with no body, a body that is no text, or meta that reads as no
/// document is named by nothing: `nameToSeed` answers `null` for each.
#[test]
fn a_node_without_a_readable_body_or_meta_is_not_seeded() {
    use crate::test_record::{ID_A, ID_B, ID_C, add_node, document_meta, meta_of, snapshot};
    let doc = LoroDoc::new();
    add_node(&doc, None, &document_meta(ID_A, "untitled"));
    add_node(&doc, None, &[("documentId", ID_B.to_owned()), ("segment", "untitled-2".to_owned())]);
    let mapped = add_node(&doc, None, &document_meta(ID_C, "untitled-3"));
    let body = meta_of(&doc, mapped).insert_container("body", whiteboard_crdt::LoroMap::new());
    body.expect("a body").insert("text", "# Plan").expect("an entry");
    let seed = |id: &str| Write {
        op: WriterName::SeedNameFromTitle,
        args: args(&[("documentId", s(id))]),
    };
    let batch = [seed(ID_A), seed(ID_B), seed(ID_C)];
    let done = write_workspace_batch(&snapshot(&doc), 1, &batch, WriteJudge::None, 1.0);
    let done = done.expect("answered");
    assert!(matches!(done.answer, WriteAnswer::Applied(_)), "{:?}", done.answer);
    let documents = crate::record::WorkspaceRecord::over(&done.doc).documents();
    assert_eq!(documents.len(), 2, "the node without a kind is no document");
    assert!(documents.iter().all(|found| found.name.is_none()), "{documents:?}");
}
