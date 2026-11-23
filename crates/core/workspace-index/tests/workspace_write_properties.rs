//! The workspace writers as a property over batches drawn here: a batch over a
//! record that already holds a document `old` answers as `changed` exactly the
//! documents it created that are still standing after it, in the order it
//! created them, and its update rebuilds the record it leaves.
//!
//! Every batch creates `keep` first, which nothing after it moves or deletes,
//! and `gone`, which its last write deletes by id; nothing in it writes to
//! `old`. So every draw holds a document created and kept, one created and
//! deleted, and one never touched, whatever the random writes between do
//! (create under the root or `keep`, make folders, move and delete by path).
//! The expected documents are read off the record's listing after the batch,
//! not through the touched-documents reader the property judges.

use std::collections::BTreeMap;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ExportMode, LoroDoc, WriteAnswer, deep_value_with_id, import_bytes};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use whiteboard_proptest::proptest::prelude::{
    Strategy, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};
use whiteboard_workspace_index::{WorkspaceRecord, write_workspace_batch};

const OLD: &str = "01ARZ3NDEKTSV4RRFFQ69G5F00";
const KEEP: &str = "01ARZ3NDEKTSV4RRFFQ69G5F01";
const GONE: &str = "01ARZ3NDEKTSV4RRFFQ69G5F02";
const SEGMENTS: [&str; 3] = ["x", "y", "z"];
const FROM: [&str; 5] = ["x", "y", "x/y", "keep/x", "gone"];
const TO: [&str; 2] = ["m", "m/n"];
const FOLDERS: [&str; 3] = ["x/y", "m/n/o", "keep/q"];

#[cfg(test)]
#[derive(Debug, Clone)]
enum Step {
    Create { segment: usize, under_keep: bool },
    Ensure(usize),
    Move(usize, usize),
    Delete(usize),
}

#[cfg(test)]
fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        (0..SEGMENTS.len(), prop::bool::ANY)
            .prop_map(|(segment, under_keep)| Step::Create { segment, under_keep }),
        (0..FOLDERS.len()).prop_map(Step::Ensure),
        (0..FROM.len(), 0..TO.len()).prop_map(|(from, to)| Step::Move(from, to)),
        (0..FROM.len()).prop_map(Step::Delete),
    ]
}

#[cfg(test)]
fn args(entries: &[(&str, &str)]) -> Value {
    Value::Map(
        entries.iter().map(|(k, v)| ((*k).to_owned(), Value::String((*v).to_owned()))).collect(),
    )
}

#[cfg(test)]
fn create(id: &str, segment: &str, parent: Option<&str>) -> Write {
    let mut entries = vec![("documentId", id), ("segment", segment), ("kind", "markdown")];
    entries.extend(parent.map(|parent| ("parentId", parent)));
    Write { op: WriterName::CreateWorkspaceDocument, args: args(&entries) }
}

/// The batch a draw writes, and the ids it creates in the order it creates them.
#[cfg(test)]
fn batch_of(steps: &[Step]) -> (Vec<Write>, Vec<String>) {
    let mut batch = vec![create(KEEP, "keep", None), create(GONE, "gone", None)];
    let mut created = vec![KEEP.to_owned(), GONE.to_owned()];
    for (i, step) in steps.iter().enumerate() {
        batch.push(match step {
            Step::Create { segment, under_keep } => {
                created.push(format!("01ARZ3NDEKTSV4RRFFQ69G5{i:03}"));
                let id = created.last().expect("just pushed");
                create(id, SEGMENTS[*segment], under_keep.then_some(KEEP))
            }
            Step::Ensure(path) => {
                let segments =
                    FOLDERS[*path].split('/').map(|s| Value::String(s.to_owned())).collect();
                let args = Value::Map(vec![("segments".to_owned(), Value::Seq(segments))]);
                Write { op: WriterName::EnsureFolderPath, args }
            }
            Step::Move(from, to) => Write {
                op: WriterName::MoveWorkspaceNodeToPath,
                args: args(&[("from", FROM[*from]), ("to", TO[*to])]),
            },
            Step::Delete(path) => Write {
                op: WriterName::DeleteWorkspaceNodeAtPath,
                args: args(&[("path", FROM[*path])]),
            },
        });
    }
    batch.push(Write {
        op: WriterName::DeleteWorkspaceDocument,
        args: args(&[("documentId", GONE)]),
    });
    (batch, created)
}

/// A record holding the document `old` at its root.
#[cfg(test)]
fn record() -> Vec<u8> {
    let empty = LoroDoc::new().export(ExportMode::Snapshot).expect("an empty snapshot");
    let done = write_workspace_batch(&empty, 7, &[create(OLD, "old", None)], WriteJudge::None, 1.0)
        .expect("the record is written");
    done.doc.export(ExportMode::Snapshot).expect("a snapshot")
}

#[test]
fn a_batch_changes_the_documents_it_created_and_left_standing() {
    let before = record();
    let floor = Floor::new("a batch creating a document it keeps and one it deletes");
    check(prop::collection::vec(step(), 0..8), None, |steps| {
        let (batch, created) = batch_of(&steps);
        let done =
            write_workspace_batch(&before, 3, &batch, WriteJudge::None, 2.0).expect("answered");
        let WriteAnswer::Applied(applied) = done.answer else { panic!("{:?} threw", done.answer) };
        let standing: Vec<String> = WorkspaceRecord::over(&done.doc)
            .documents()
            .into_iter()
            .map(|found| found.document_id)
            .collect();
        let order: BTreeMap<&str, usize> =
            created.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
        let mut expected: Vec<String> =
            standing.iter().filter(|id| order.contains_key(id.as_str())).cloned().collect();
        expected.sort_by_key(|id| order[id.as_str()]);
        prop_assert_eq!(&applied.changed, &expected);
        prop_assert!(standing.iter().any(|id| id == OLD), "nothing deletes old");
        let rebuilt = import_bytes(&before).expect("the record");
        rebuilt
            .import(
                &applied
                    .local_update
                    .map(|u| whiteboard_model::encoding::base64_to_bytes(&u).expect("bytes"))
                    .expect("an update"),
            )
            .expect("the update");
        prop_assert_eq!(deep_value_with_id(&rebuilt), deep_value_with_id(&done.doc));
        floor.draw(
            expected.first().is_some_and(|id| id == KEEP) && !expected.iter().any(|id| id == GONE),
        );
        Ok(())
    });
    floor.assert(150);
}
