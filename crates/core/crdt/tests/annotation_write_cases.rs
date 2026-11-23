//! The annotation, proposal and document-batch writers and the content restore
//! over documents written here, for the arrangements the recording lacks: an
//! anchor the TypeScript refuses for a fractional, missing or non-finite
//! coordinate, a thread or proposal written over one held, over a scalar (npm
//! loro-crdt throws) and over null; replies, verdicts and moves to threads and
//! changes that are not held, not readable or not objects; a move that stays,
//! one onto an edge and one carrying a null node; passages clamped to the
//! body, dropped past it, named twice and named by an id the style key
//! escapes, and the retired comment plane refusing them; a verdict spreading a
//! change with integer keys; batches of a verdict and a body, of an unknown op
//! and of a reconcile that throws; and a restore of one root — the body, a
//! thread synced into its container, a flattened thread, a value over a map, a
//! nested text or list, values unequal by depth, key and kind, a key the past
//! dropped, a counter root the restore passes over, an equal past, and a text
//! or map root the past lacks; and a verdict adding the status a change lacked.
//!
//! `fixtures/annotation_write_cases.jsonl` holds each case as the engine's
//! recorder writes a writer row, answered by the TypeScript's engine with
//! `judge: "none"`. Then what is not answered here: the arguments the
//! TypeScript's types refuse, a restore that changes several roots, and one
//! the TypeScript would misread (a container handle compared as an object,
//! bytes compared as a typed array, a tree, a root named `__proto__`).

#[cfg(test)]
mod support;
#[cfg(test)]
mod write_replay;

use support::{base64_decode, rows_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ExportMode, LoroDoc, WriteAnswer, write_batch};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use write_replay::check_write;

const CASES: &str = include_str!("fixtures/annotation_write_cases.jsonl");

#[test]
#[cfg(test)]
fn every_case_is_answered_as_the_typescript_answered_it() {
    let rows = rows_of(CASES);
    let lines = CASES.lines().filter(|line| !line.is_empty());
    let mut thrown = 0;
    for (row, line) in rows.iter().zip(lines) {
        let name = row["name"].as_str().expect("a name");
        assert!(check_write(name, row, line), "{name} was not answered");
        thrown += usize::from(row["result"].get("err").is_some());
    }
    assert_eq!(rows.len(), 56, "the cases held");
    assert_eq!(thrown, 9, "the cases a writer threw in");
}

#[cfg(test)]
fn object(entries: &[(&str, Value)]) -> Value {
    Value::Map(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
}

#[cfg(test)]
fn text(s: &str) -> Value {
    Value::String(s.to_owned())
}

#[cfg(test)]
fn number(n: f64) -> Value {
    Value::Number(n)
}

/// A document holding one thread `t` at a spatial point, a body, and one
/// proposal `p` holding change `c`.
#[cfg(test)]
fn held() -> Vec<u8> {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).expect("a peer");
    doc.get_text("body").insert(0, "ab").expect("a body");
    let thread = doc.get_map("threads").ensure_mergeable_map("t").expect("a thread");
    let anchor = object(&[("kind", text("spatial")), ("x", number(1.0)), ("y", number(2.0))]);
    thread.insert("anchor", plain(&anchor)).expect("an anchor");
    thread.insert("status", "open").expect("a status");
    let messages = thread.ensure_mergeable_map("messages").expect("messages");
    messages.insert("m", plain(&object(&[("id", text("m")), ("body", text("hi"))]))).expect("m");
    let proposal = doc.get_map("proposals").ensure_mergeable_map("p").expect("a proposal");
    let changes = proposal.ensure_mergeable_map("changes").expect("changes");
    changes.insert("c", plain(&object(&[("id", text("c")), ("status", text("open"))]))).expect("c");
    doc.commit();
    doc.export(ExportMode::Snapshot).expect("a snapshot")
}

#[cfg(test)]
fn plain(value: &Value) -> whiteboard_crdt::LoroValue {
    match value {
        Value::String(s) => s.as_str().into(),
        Value::Number(n) => (*n).into(),
        Value::Map(entries) => whiteboard_crdt::LoroValue::Map(
            entries.iter().map(|(k, v)| (k.clone(), plain(v))).collect(),
        ),
        _ => whiteboard_crdt::LoroValue::Null,
    }
}

#[cfg(test)]
fn answered(op: WriterName, args: Value) -> Option<WriteAnswer> {
    write_batch(&held(), 3, &[Write { op, args }], WriteJudge::None).map(|done| done.answer)
}

/// What a thread write refuses: its arguments' types, and a value holding the
/// reserved key.
#[cfg(test)]
fn thread_refusals() -> Vec<(WriterName, Value)> {
    let point = object(&[("kind", text("spatial")), ("x", number(1.0)), ("y", number(2.0))]);
    let thread = |entries: &[(&str, Value)]| object(&[("thread", object(entries))]);
    let messages = Value::Seq(vec![object(&[("id", text("m")), ("body", text("b"))])]);
    let proto = whiteboard_model::json::parse(r#"{"__proto__":1}"#).expect("json");
    vec![
        (WriterName::WriteCommentThread, object(&[])),
        (WriterName::WriteCommentThread, thread(&[("anchor", text("a"))])),
        (WriterName::WriteCommentThread, thread(&[("anchor", point.clone())])),
        (
            WriterName::WriteCommentThread,
            thread(&[("id", number(1.0)), ("anchor", point.clone()), ("status", text("open"))]),
        ),
        (
            WriterName::WriteCommentThread,
            thread(&[("id", text("t")), ("anchor", point.clone()), ("messages", messages.clone())]),
        ),
        (
            WriterName::WriteCommentThread,
            thread(&[
                ("id", text("t")),
                ("anchor", point.clone()),
                ("status", proto.clone()),
                ("messages", messages.clone()),
            ]),
        ),
        (
            WriterName::WriteCommentThread,
            thread(&[
                ("id", text("t")),
                ("anchor", point.clone()),
                ("status", text("open")),
                ("messages", Value::Seq(vec![object(&[("id", text("m"))])])),
            ]),
        ),
    ]
}

/// What a reply, a status, a move and a mark refuse.
#[cfg(test)]
fn reply_refusals() -> Vec<(WriterName, Value)> {
    vec![
        (WriterName::WriteThreadMessage, object(&[("threadId", number(1.0))])),
        (WriterName::WriteThreadMessage, object(&[("threadId", text("t"))])),
        (WriterName::SetCommentThreadStatus, object(&[("threadId", text("t"))])),
        (WriterName::MoveCommentThread, object(&[("threadId", text("t"))])),
        (WriterName::MoveCommentThread, object(&[("threadId", text("t")), ("drop", text("d"))])),
        (WriterName::MarkThreadPassages, object(&[("passages", text("p"))])),
        (
            WriterName::MarkThreadPassages,
            object(&[("passages", Value::Seq(vec![Value::Seq(vec![text("t")])]))]),
        ),
        (
            WriterName::MarkThreadPassages,
            object(&[("passages", Value::Seq(vec![Value::Seq(vec![number(1.0), Value::Null])]))]),
        ),
        (
            WriterName::MarkThreadPassages,
            passages(object(&[("start", number(0.5)), ("end", number(1.0))])),
        ),
        (
            WriterName::MarkThreadPassages,
            passages(object(&[("start", number(-1.0)), ("end", number(1.0))])),
        ),
        (WriterName::MarkThreadPassages, passages(object(&[("start", number(0.0))]))),
    ]
}

/// What a proposal, a verdict, a batch and a restore refuse.
#[cfg(test)]
fn proposal_refusals() -> Vec<(WriterName, Value)> {
    vec![
        (WriterName::WriteProposal, object(&[])),
        (WriterName::WriteProposal, object(&[("proposal", object(&[("id", text("p"))]))])),
        (
            WriterName::WriteProposal,
            object(&[(
                "proposal",
                object(&[("id", text("p")), ("changes", Value::Seq(vec![text("c")]))]),
            )]),
        ),
        (WriterName::SetProposedChangeStatus, object(&[("proposalId", text("p"))])),
        (
            WriterName::SetProposedChangeStatus,
            object(&[("proposalId", text("p")), ("changeId", text("c"))]),
        ),
        (WriterName::WithDocumentBatch, object(&[("steps", Value::Seq(vec![Value::Null]))])),
        (
            WriterName::WithDocumentBatch,
            object(&[("steps", Value::Seq(vec![object(&[("op", text("writeMarkdownBody"))])]))]),
        ),
        (WriterName::ReconcileDocContent, object(&[("past", number(1.0))])),
        (WriterName::ReconcileDocContent, object(&[("past", text("!"))])),
        (WriterName::ReconcileDocContent, object(&[("past", text("AAAA"))])),
    ]
}

#[test]
#[cfg(test)]
fn what_the_typescript_types_refuse_is_not_answered() {
    let refused = [thread_refusals(), reply_refusals(), proposal_refusals()].concat();
    for (op, args) in refused {
        assert_eq!(answered(op, args.clone()), None, "{op:?} {args:?}");
    }
}

#[cfg(test)]
fn passages(range: Value) -> Value {
    object(&[("passages", Value::Seq(vec![Value::Seq(vec![text("t"), range])]))])
}

#[test]
#[cfg(test)]
fn a_verdict_on_a_change_holding_bytes_or_a_container_is_not_answered() {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).expect("a peer");
    let proposal = doc.get_map("proposals").ensure_mergeable_map("p").expect("a proposal");
    let changes = proposal.ensure_mergeable_map("changes").expect("changes");
    let bytes = whiteboard_crdt::LoroValue::Binary(vec![1_u8].into());
    changes.insert("bytes", whiteboard_crdt::loro_value!({ "b": bytes })).expect("bytes");
    changes.insert_container("nested", whiteboard_crdt::LoroMap::new()).expect("nested");
    changes.insert("list", vec![1_i64]).expect("a list");
    doc.commit();
    let before = doc.export(ExportMode::Snapshot).expect("a snapshot");
    for change in ["bytes", "nested", "list"] {
        let args = object(&[
            ("proposalId", text("p")),
            ("changeId", text(change)),
            ("status", text("adopted")),
        ]);
        let write = Write { op: WriterName::SetProposedChangeStatus, args };
        assert!(write_batch(&before, 3, &[write], WriteJudge::None).is_none(), "{change}");
    }
}

/// A body `ab` and a facet bucket: `edit` changes the past in a second root.
#[cfg(test)]
fn restored(edit: impl Fn(&LoroDoc)) -> Option<WriteAnswer> {
    let past = LoroDoc::new();
    past.set_peer_id(1).expect("a peer");
    past.get_text("body").insert(0, "ab").expect("a body");
    past.get_map("facets").insert("a.b/v1", 1).expect("a facet");
    edit(&past);
    past.commit();
    let bytes = past.export(ExportMode::Snapshot).expect("a snapshot");
    let past = whiteboard_model::encoding::bytes_to_base64(&bytes);
    let write =
        Write { op: WriterName::ReconcileDocContent, args: object(&[("past", text(&past))]) };
    write_batch(&held(), 3, &[write], WriteJudge::None).map(|done| done.answer)
}

#[test]
#[cfg(test)]
fn a_restore_that_changes_several_roots_is_not_answered() {
    // The past holds a body and a facet bucket and no threads or proposals, so
    // a restore over `held` clears two roots and fills a third; then clears
    // two; then the past holds a sequence root.
    let threads_and_proposals = |past: &LoroDoc| {
        past.get_text("body").delete(0, 2).expect("a body");
        past.get_text("body").insert(0, "ab").expect("the body again");
    };
    assert!(restored(threads_and_proposals).is_none(), "threads, proposals and facets differ");
    let one_root = |past: &LoroDoc| {
        past.get_map("facets").delete("a.b/v1").expect("no facet");
    };
    assert!(restored(one_root).is_none(), "threads and proposals differ");
    let sequence = |past: &LoroDoc| {
        past.get_list("legacy").push(1).expect("a list");
    };
    assert!(restored(sequence).is_none(), "a sequence root");
}

#[test]
#[cfg(test)]
fn a_restore_that_changes_one_root_is_answered() {
    let doc = LoroDoc::from_snapshot(&held()).expect("held");
    doc.get_text("body").insert(2, "c").expect("a body");
    doc.commit();
    let bytes = doc.export(ExportMode::Snapshot).expect("a snapshot");
    let past = whiteboard_model::encoding::bytes_to_base64(&bytes);
    let write =
        Write { op: WriterName::ReconcileDocContent, args: object(&[("past", text(&past))]) };
    let done = write_batch(&held(), 3, &[write], WriteJudge::None).expect("answered");
    let WriteAnswer::Applied(applied) = done.answer else { panic!("applied") };
    assert!(applied.local_update.is_some());
    assert_eq!(done.doc.get_text("body").to_string(), "abc");
    assert!(write_batch(&base64_decode("AAAA"), 3, &[], WriteJudge::None).is_none());
}

/// A restore of the facet bucket alone, from `target` to `past`.
#[cfg(test)]
fn restore_facets(target: impl Fn(&LoroDoc), past: impl Fn(&LoroDoc)) -> Option<WriteAnswer> {
    let written = |edit: &dyn Fn(&LoroDoc)| {
        let doc = LoroDoc::new();
        doc.set_peer_id(1).expect("a peer");
        doc.get_text("body").insert(0, "ab").expect("a body");
        edit(&doc);
        doc.commit();
        doc.export(ExportMode::Snapshot).expect("a snapshot")
    };
    let past = whiteboard_model::encoding::bytes_to_base64(&written(&past));
    let write =
        Write { op: WriterName::ReconcileDocContent, args: object(&[("past", text(&past))]) };
    write_batch(&written(&target), 3, &[write], WriteJudge::None).map(|done| done.answer)
}

#[test]
#[cfg(test)]
fn a_restore_the_typescript_would_misread_is_not_answered() {
    let facets = |doc: &LoroDoc| doc.get_map("facets");
    let over_text = |doc: &LoroDoc| {
        facets(doc).insert_container("k", whiteboard_crdt::LoroText::new()).expect("a text");
    };
    // `jsonEqual` would read a text handle's own keys against an object.
    let object_value = |doc: &LoroDoc| {
        facets(doc).insert("k", whiteboard_crdt::loro_value!({ "a": 1 })).expect("a value");
    };
    assert!(restore_facets(over_text, object_value).is_none(), "an object over a text");
    let scalar = |doc: &LoroDoc| {
        facets(doc).insert("k", 1).expect("a value");
    };
    assert!(restore_facets(over_text, scalar).is_some(), "a scalar over a text is written");
    let tree = |doc: &LoroDoc| {
        facets(doc).insert_container("k", loro::LoroTree::new()).expect("a tree");
    };
    assert!(restore_facets(scalar, tree).is_none(), "a tree no copy carries");
    let bytes = |doc: &LoroDoc| {
        let held = whiteboard_crdt::LoroValue::Binary(vec![1_u8].into());
        facets(doc).insert("k", held).expect("bytes");
    };
    assert!(restore_facets(scalar, bytes).is_none(), "bytes reach JavaScript as a typed array");
    assert!(restore_facets(bytes, scalar).is_none(), "and are compared there by index");
    let proto = |doc: &LoroDoc| {
        doc.get_map("__proto__").insert("k", 1).expect("a root");
    };
    assert!(restore_facets(scalar, proto).is_none(), "a root JavaScript cannot name");
}
