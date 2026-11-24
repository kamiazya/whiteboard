//! The engine's workspace writers, for the arrangements the recording lacks,
//! against what the TypeScript's engine answered for them: each refusal's
//! class, a tree id written every way npm loro-crdt reads one, the meta a
//! created document's schema refuses, a move the tree refuses, a record that
//! held no tree, and batches whose writes touch documents in turn.
//!
//! `fixtures/workspace_write_cases.jsonl` holds the record's bytes (the row
//! with a `snapshot`; `empty` is a document holding nothing) and each batch
//! with the TypeScript's answer: the class it threw, or the documents it
//! changed, whether it wrote an update, and the record's deep value after it.

#[cfg(test)]
#[path = "../../crdt/tests/support/mod.rs"]
#[expect(dead_code, reason = "the shared helpers are each used by some of the recordings' tests")]
mod support;

use support::{assert_same, base64_decode, model_of, rows_of, without_proto};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ExportMode, LoroDoc, WriteAnswer, deep_value, import_bytes};
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use whiteboard_workspace_index::write_workspace_batch;

const CASES: &str = include_str!("fixtures/workspace_write_cases.jsonl");
const RECORDED_NOW: f64 = 1_700_000_000_000.0;

#[cfg(test)]
fn batch_of(row: &serde_json::Value) -> Vec<Write> {
    let writes = row["batch"].as_array().expect("a batch");
    writes
        .iter()
        .map(|write| Write {
            op: WriterName::from_wire(write["op"].as_str().expect("an op")).expect("a writer"),
            args: model_of(&write["args"]),
        })
        .collect()
}

#[test]
fn every_case_is_answered_as_the_typescript_answered_it() {
    let rows = rows_of(CASES);
    let record = base64_decode(rows[0]["snapshot"].as_str().expect("the record"));
    let empty = LoroDoc::new().export(ExportMode::Snapshot).expect("an empty document");
    assert!(rows.len() > 60, "{} cases", rows.len());
    for row in &rows[1..] {
        let name = row["name"].as_str().expect("a name");
        let before = if row["base"] == "empty" { &empty } else { &record };
        let written =
            write_workspace_batch(before, 1, &batch_of(row), WriteJudge::None, RECORDED_NOW)
                .unwrap_or_else(|| panic!("{name}: not answered"));
        let expected = &row["result"];
        match written.answer {
            WriteAnswer::Thrown(class) => {
                assert_eq!(expected["err"], class, "{name}");
                assert_rolled_back(name, before, &written.doc);
            }
            WriteAnswer::Applied(applied) => {
                assert_eq!(expected["changed"], serde_json::json!(applied.changed), "{name}");
                assert_eq!(expected["update"], applied.local_update.is_some(), "{name} update");
                let bytes = written.doc.export(ExportMode::Snapshot).expect("a snapshot");
                let after = import_bytes(&bytes).expect("the snapshot");
                assert_same(name, &without_proto(&deep_value(&after)).0, &model_of(&row["deep"]));
            }
        }
    }
}

/// The whole batch undone: what a throw leaves is the record as it was given.
#[cfg(test)]
fn assert_rolled_back(name: &str, before: &[u8], after: &LoroDoc) {
    let given = import_bytes(before).expect("the record");
    assert_same(name, &deep_value(after), &deep_value(&given));
    assert_eq!(after.oplog_vv(), given.oplog_vv(), "{name} version");
}

#[test]
fn a_throw_part_way_through_a_batch_keeps_none_of_its_writes() {
    let rows = rows_of(CASES);
    let record = base64_decode(rows[0]["snapshot"].as_str().expect("the record"));
    let held = whiteboard_workspace_index::WorkspaceRecord::over(
        &import_bytes(&record).expect("a record"),
    )
    .documents();
    let id = held.first().expect("a document").document_id.clone();
    let rename = |id: &str| Write {
        op: WriterName::SetWorkspaceDocumentName,
        args: model_of(&serde_json::json!({ "documentId": id, "name": "Renamed" })),
    };
    let batch = [rename(&id), rename("01ARZ3NDEKTSV4RRFFQ69G5FZZ")];
    let written = write_workspace_batch(&record, 1, &batch, WriteJudge::None, RECORDED_NOW)
        .expect("answered");
    assert_eq!(written.answer, WriteAnswer::Thrown("Error"));
    assert_rolled_back("rename then an absent rename", &record, &written.doc);
}

#[test]
fn a_writer_given_an_argument_its_types_refuse_is_left_to_the_caller() {
    let record = LoroDoc::new().export(ExportMode::Snapshot).expect("bytes");
    let declined = |op: WriterName, args: &str| {
        let args = whiteboard_model::json::parse(args).expect("arguments");
        write_workspace_batch(&record, 1, &[Write { op, args }], WriteJudge::None, 0.0).is_none()
    };
    let id = r#""documentId":"01ARZ3NDEKTSV4RRFFQ69G5FZZ""#;
    for (op, args) in [
        (
            WriterName::CreateWorkspaceDocumentAtPath,
            format!(r#"{{"path":1,{id},"kind":"spatial"}}"#),
        ),
        (
            WriterName::CreateWorkspaceDocument,
            format!(r#"{{"segment":"a",{id},"kind":"spatial","createdAt":"1"}}"#),
        ),
        (
            WriterName::CreateWorkspaceDocument,
            format!(r#"{{"segment":"a",{id},"kind":"spatial","parentId":2}}"#),
        ),
        (WriterName::CreateWorkspaceDocument, r#"{"segment":"a","kind":"spatial"}"#.to_owned()),
        (WriterName::EnsureFolderPath, r#"{"segments":"a"}"#.to_owned()),
        (WriterName::EnsureFolderPath, r#"{"segments":["a",1]}"#.to_owned()),
        (WriterName::MoveWorkspaceNodeToPath, r#"{"from":"a"}"#.to_owned()),
        (WriterName::SetWorkspaceFolderName, r#"{"path":"a","name":null}"#.to_owned()),
        (WriterName::DeleteWorkspaceNode, r#"{"id":0}"#.to_owned()),
    ] {
        assert!(declined(op, &args), "{op:?} {args}");
    }
}

#[test]
fn a_write_the_record_does_not_answer_is_left_to_the_caller() {
    let record = LoroDoc::new().export(ExportMode::Snapshot).expect("bytes");
    // A hosted document named by anything but its id's text, which the
    // writer's types refuse.
    let hosted = whiteboard_model::json::parse(r#"{"documentId":7,"body":"b"}"#).expect("args");
    let write = Write { op: WriterName::WriteMarkdownBody, args: hosted };
    assert!(write_workspace_batch(&record, 1, &[write], WriteJudge::None, 0.0).is_none());
}
