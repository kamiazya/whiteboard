//! The record's content writers as properties over draws made here.
//!
//! - A title the body announces is the title of a heading holding it: deriving
//!   one is idempotent over the blanks a closing marker follows, as the
//!   TypeScript's comment requires. Every draw is a
//!   heading over text that starts on a non-blank and is short enough, so every
//!   draw announces a title.
//! - `stampEditedDocuments` stamps exactly the documents whose content an
//!   earlier batch wrote, and none it only renamed. Every draw writes the body
//!   of the first document and only renames the second (the drawn writes reach
//!   the others), so every draw holds both.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ExportMode, LoroDoc, WriteAnswer, version_pairs};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use whiteboard_model::encoding::bytes_to_base64;
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert_eq};
use whiteboard_proptest::{Floor, check};
use whiteboard_workspace_index::title_from_body::title_from_markdown_body;
use whiteboard_workspace_index::{WorkspaceRecord, write_workspace_batch};

/// No whitespace but the space and the tab: a closing marker run is dropped
/// only after one of those, while every whitespace run collapses to a space,
/// so `# T\u{3000}#` reads `T #` and a heading of that reads `T` — the
/// TypeScript answers both the same way (`markdown_titles.json`).
#[cfg(test)]
const PIECES: [&str; 8] = ["a", "日本", "#", " ", "\t", "C#", "😀", "x y"];

#[test]
fn a_title_is_the_title_of_a_heading_holding_it() {
    let floor = Floor::new("a heading announcing a title");
    let text = prop::collection::vec(0..PIECES.len(), 0..12)
        .prop_map(|picks| picks.into_iter().map(|i| PIECES[i]).collect::<String>());
    check(text, None, |tail| {
        let body = format!("\n# T{tail}\nmore");
        let title = title_from_markdown_body(&body);
        floor.draw(title.is_some());
        if let Some(title) = title {
            prop_assert_eq!(title_from_markdown_body(&format!("# {title}")), Some(title));
        }
        Ok(())
    });
    floor.assert(200);
}

#[cfg(test)]
fn map(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

#[cfg(test)]
fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

#[cfg(test)]
fn id(i: usize) -> String {
    format!("01ARZ3NDEKTSV4RRFFQ69G5F{i:02}")
}

#[cfg(test)]
fn write(op: WriterName, args: Value) -> Write {
    Write { op, args }
}

#[cfg(test)]
fn applied(before: &[u8], batch: &[Write], now_ms: f64) -> LoroDoc {
    let done = write_workspace_batch(before, 1, batch, WriteJudge::None, now_ms).expect("answered");
    assert!(matches!(done.answer, WriteAnswer::Applied(_)), "{:?}", done.answer);
    done.doc
}

/// A standalone document holding `body`, as base64 snapshot bytes.
#[cfg(test)]
fn source(body: &str) -> Value {
    let doc = LoroDoc::new();
    doc.get_text("body").insert(0, body).expect("a body");
    doc.commit();
    text(&bytes_to_base64(&doc.export(ExportMode::Snapshot).expect("a snapshot")))
}

/// The version `created` is at, as the `since` a stamp is handed.
#[cfg(test)]
fn since_of(created: &LoroDoc) -> Value {
    Value::Seq(
        version_pairs(created)
            .into_iter()
            .map(|(peer, counter)| {
                Value::Seq(vec![
                    text(&peer),
                    Value::Number(counter.to_string().parse().expect("a counter")),
                ])
            })
            .collect(),
    )
}

/// A batch writing the content of each `(i, true)` step and renaming each
/// `(i, false)` one, with the documents whose content it wrote.
#[cfg(test)]
fn batch_of(steps: &[(usize, bool)]) -> (Vec<Write>, Vec<String>) {
    let mut written = Vec::new();
    let batch = steps
        .iter()
        .map(|&(i, content)| {
            if content {
                written.push(id(i));
                let args = map(vec![("documentId", text(&id(i))), ("source", source("edited"))]);
                write(WriterName::WriteWorkspaceDocumentContent, args)
            } else {
                let args = map(vec![("documentId", text(&id(i))), ("name", text("Renamed"))]);
                write(WriterName::SetWorkspaceDocumentName, args)
            }
        })
        .collect();
    written.sort();
    written.dedup();
    (batch, written)
}

/// The documents of `record` whose update time is `at`, sorted.
#[cfg(test)]
fn stamped_at(record: &LoroDoc, at: f64) -> Vec<String> {
    let mut moved: Vec<String> = WorkspaceRecord::over(record)
        .documents()
        .into_iter()
        .filter(|found| found.updated_at == Some(at))
        .map(|found| found.document_id)
        .collect();
    moved.sort();
    moved
}

#[test]
fn a_stamp_moves_exactly_the_documents_whose_content_was_written() {
    const DOCUMENTS: usize = 5;
    let create = |i: usize| {
        let args = map(vec![
            ("path", text(&format!("d{i}"))),
            ("documentId", text(&id(i))),
            ("kind", text("markdown")),
        ]);
        write(WriterName::CreateWorkspaceDocumentAtPath, args)
    };
    let empty = LoroDoc::new().export(ExportMode::Snapshot).expect("an empty snapshot");
    let created = applied(&empty, &(0..DOCUMENTS).map(create).collect::<Vec<_>>(), 1.0);
    let before = created.export(ExportMode::Snapshot).expect("a snapshot");
    let since = since_of(&created);
    let floor = Floor::new("a batch writing one document's content and renaming another");
    let picks = prop::collection::vec((2..DOCUMENTS, prop::bool::ANY), 0..6);
    check(picks, None, |picks| {
        let mut steps = vec![(0, true), (1, false)];
        steps.extend(picks);
        let (batch, expected) = batch_of(&steps);
        let edited = applied(&before, &batch, 2.0).export(ExportMode::Snapshot).expect("bytes");
        let stamp = map(vec![("since", since.clone()), ("at", Value::Number(9.0))]);
        let stamped = applied(&edited, &[write(WriterName::StampEditedDocuments, stamp)], 3.0);
        let moved = stamped_at(&stamped, 9.0);
        floor.draw(moved.contains(&id(0)) && !moved.contains(&id(1)));
        prop_assert_eq!(moved, expected);
        Ok(())
    });
    floor.assert(150);
}
