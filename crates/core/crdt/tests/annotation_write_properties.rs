//! The annotation and proposal writers as properties over documents written
//! here: what a thread write and a reply leave is what the reader answers, a
//! passage marks exactly the range clamped to the body, and a verdict stamps
//! the status and keeps every other field — and restating any of them writes
//! nothing.
//!
//! Every draw reaches the case each floor counts by construction: a thread
//! always holds a message the reply edits and one it leaves, one passage
//! always ends past the body and one inside it, and a change always holds a
//! status the verdict replaces. What is expected is built from the draw, not
//! read back through a writer.

use std::collections::BTreeMap;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ExportMode, LoroDoc, WriteAnswer, answer_content_query, deep_value};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName, Write, WriteJudge, WriterName};
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert, prop_assert_eq};
use whiteboard_proptest::{Floor, check};

#[cfg(test)]
fn object(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

#[cfg(test)]
fn text(s: &str) -> Value {
    Value::String(s.to_owned())
}

#[cfg(test)]
fn number(n: usize) -> Value {
    Value::Number(f64::from(u32::try_from(n).expect("a small number")))
}

#[cfg(test)]
fn snapshot(doc: &LoroDoc) -> Vec<u8> {
    doc.export(ExportMode::Snapshot).expect("a snapshot")
}

/// The batch applied: whether it wrote, and the document after it.
#[cfg(test)]
fn apply(before: &[u8], batch: Vec<(WriterName, Value)>) -> (bool, Vec<u8>) {
    let batch: Vec<Write> = batch.into_iter().map(|(op, args)| Write { op, args }).collect();
    let done = whiteboard_crdt::write_batch(before, 3, &batch, WriteJudge::None).expect("answered");
    let WriteAnswer::Applied(applied) = done.answer else { panic!("applied") };
    (applied.local_update.is_some(), snapshot(&done.doc))
}

#[cfg(test)]
fn read(bytes: &[u8], query: QueryName) -> Value {
    let doc = LoroDoc::from_snapshot(bytes).expect("a snapshot");
    let answer = answer_content_query(&doc, &Query { query, args: None }).expect("answered");
    let Value::Map(mut answer) = answer.value else { panic!("an answer") };
    answer.remove(0).1
}

/// Message ids and bodies beside the fixed `m0` the reply edits and `m9` it leaves.
#[cfg(test)]
fn messages() -> impl Strategy<Value = BTreeMap<String, String>> {
    let id = (1_u8..8).prop_map(|n| format!("m{n}"));
    prop::collection::btree_map(id, "[a-z]{1,4}", 0..4).prop_map(|mut held| {
        held.insert("m0".to_owned(), "first".to_owned());
        held.insert("m9".to_owned(), "last".to_owned());
        held
    })
}

#[cfg(test)]
fn message(id: &str, body: &str) -> Value {
    object(vec![("id", text(id)), ("body", text(body))])
}

#[cfg(test)]
fn thread(status: &str, held: &BTreeMap<String, String>) -> Value {
    let anchor = object(vec![("kind", text("document"))]);
    let messages = held.iter().map(|(id, body)| message(id, body)).collect();
    let thread = object(vec![
        ("id", text("t")),
        ("anchor", anchor),
        ("status", text(status)),
        ("messages", Value::Seq(messages)),
    ]);
    object(vec![("thread", thread)])
}

#[test]
#[cfg(test)]
fn a_thread_and_a_reply_read_back_as_written_and_restating_them_writes_nothing() {
    let kept = Floor::new("a reply that edited one message and left another");
    let statuses = prop::sample::select(vec!["open", "resolved"]);
    check((messages(), statuses), None, |(held, status)| {
        let reply = object(vec![("threadId", text("t")), ("message", message("m0", "edited"))]);
        let batch = vec![
            (WriterName::WriteCommentThread, thread(status, &held)),
            (WriterName::WriteThreadMessage, reply),
        ];
        let (wrote, after) = apply(&snapshot(&LoroDoc::new()), batch.clone());
        prop_assert!(wrote);
        let mut expected = held.clone();
        expected.insert("m0".to_owned(), "edited".to_owned());
        let messages = expected
            .iter()
            .map(|(id, body)| object(vec![("id", text(id)), ("body", text(body))]))
            .collect();
        // `commentThreadSchema`'s order, which the TypeScript's reader parses through.
        let read_back = Value::Seq(vec![object(vec![
            ("id", text("t")),
            ("anchor", object(vec![("kind", text("document"))])),
            ("status", text(status)),
            ("messages", Value::Seq(messages)),
        ])]);
        prop_assert_eq!(read(&after, QueryName::CommentThreads), read_back);
        let restated = vec![
            (WriterName::WriteCommentThread, thread(status, &expected)),
            batch.last().cloned().expect("the reply"),
        ];
        prop_assert!(!apply(&after, restated).0, "restating the thread wrote");
        kept.draw(expected.get("m9").is_some_and(|body| body == "last"));
        Ok(())
    });
    kept.assert(150);
}

/// A body, and a passage inside it as `(start, end)` with `start < end`.
#[cfg(test)]
fn passages() -> impl Strategy<Value = (String, (usize, usize), usize)> {
    ("[a-z ]{0,12}", 0_usize..20, 0_usize..20, 1_usize..9).prop_map(|(tail, a, b, past)| {
        let body = format!("abc{tail}");
        let length = body.len();
        let (low, high) = (a.min(b) % length, a.max(b) % length);
        let (start, end) = if low < high { (low, high) } else { (0, length) };
        (body, (start, end), past)
    })
}

#[cfg(test)]
fn range(start: usize, end: usize) -> Value {
    object(vec![("start", number(start)), ("end", number(end))])
}

/// A range as the reader writes it, keys ascending.
#[cfg(test)]
fn read_range(start: usize, end: usize) -> Value {
    object(vec![("end", number(end)), ("start", number(start))])
}

#[test]
#[cfg(test)]
fn a_passage_marks_its_range_clamped_to_the_body() {
    let clamped = Floor::new("a passage running past the body's end");
    check(passages(), None, |(body, (start, end), past)| {
        let doc = LoroDoc::new();
        doc.get_text("body").insert(0, &body).expect("a body");
        doc.commit();
        let length = body.len();
        let marked = Value::Seq(vec![
            Value::Seq(vec![text("inside"), range(start, end)]),
            Value::Seq(vec![text("over"), range(start, length + past)]),
        ]);
        let args = object(vec![("passages", marked)]);
        let (wrote, after) = apply(&snapshot(&doc), vec![(WriterName::MarkThreadPassages, args)]);
        prop_assert!(wrote);
        let Value::Map(marks) = read(&after, QueryName::ThreadMarks) else { panic!("marks") };
        let Some((_, Value::Seq(marks))) = marks.into_iter().next() else { panic!("a map") };
        let found: BTreeMap<String, Value> = marks
            .into_iter()
            .map(|pair| match pair {
                Value::Seq(pair) => match pair.as_slice() {
                    [Value::String(id), range] => (id.clone(), range.clone()),
                    other => panic!("{other:?}"),
                },
                other => panic!("{other:?}"),
            })
            .collect();
        prop_assert_eq!(found.get("inside"), Some(&read_range(start, end)));
        prop_assert_eq!(found.get("over"), Some(&read_range(start, length)));
        clamped.draw(length + past > length);
        Ok(())
    });
    clamped.assert(150);
}

/// A change's fields beside its fixed `id` and the `status` a verdict replaces.
#[cfg(test)]
fn changes() -> impl Strategy<Value = BTreeMap<String, u8>> {
    prop::collection::btree_map((0_u8..6).prop_map(|k| format!("k{k}")), 0_u8..9, 0..5)
}

#[cfg(test)]
fn change(fields: &BTreeMap<String, u8>, status: &str) -> Value {
    let mut entries = vec![("id".to_owned(), text("c")), ("status".to_owned(), text(status))];
    entries.extend(fields.iter().map(|(k, v)| (k.clone(), Value::Number(f64::from(*v)))));
    Value::Map(entries)
}

#[cfg(test)]
fn stored_change(bytes: &[u8]) -> Value {
    let Value::Map(roots) = deep_value(&LoroDoc::from_snapshot(bytes).expect("bytes")) else {
        panic!("roots")
    };
    let mut at = Value::Map(roots);
    for key in ["proposals", "p", "changes", "c"] {
        let Value::Map(entries) = at else { panic!("{key}") };
        at = entries.into_iter().find(|(k, _)| k == key).expect(key).1;
    }
    at
}

#[test]
#[cfg(test)]
fn a_verdict_stamps_the_status_and_keeps_every_other_field() {
    let replaced = Floor::new("a verdict replacing the status a change held");
    check(changes(), None, |fields| {
        let proposal =
            object(vec![("id", text("p")), ("changes", Value::Seq(vec![change(&fields, "open")]))]);
        let write = (WriterName::WriteProposal, object(vec![("proposal", proposal)]));
        let (_, held) = apply(&snapshot(&LoroDoc::new()), vec![write]);
        let verdict = object(vec![
            ("proposalId", text("p")),
            ("changeId", text("c")),
            ("status", text("adopted")),
        ]);
        let stamp = vec![(WriterName::SetProposedChangeStatus, verdict)];
        let (stamped, after) = apply(&held, stamp.clone());
        prop_assert!(stamped);
        let mut expected = change(&fields, "adopted");
        if let Value::Map(entries) = &mut expected {
            entries.sort_by(|a, b| a.0.cmp(&b.0));
        }
        prop_assert_eq!(stored_change(&after), expected);
        prop_assert!(!apply(&after, stamp).0, "restating the verdict wrote");
        replaced.draw(stored_change(&held) != stored_change(&after));
        Ok(())
    });
    replaced.assert(150);
}
