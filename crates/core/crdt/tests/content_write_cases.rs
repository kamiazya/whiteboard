//! The document-content writers over documents written here, for the
//! arrangements the recording lacks: a body edit inside an astral pair and one
//! widened over a low half, edits that only delete or only insert, an
//! unchanged body, runs spliced in order and the refusals npm loro-crdt throws
//! for a run past the end, inside a pair, or a text it will not name; a kind
//! outside the enum; buckets replaced over stale and unchanged keys, integer
//! keys enumerated first, and the reserved key at any depth; the trust family
//! copying its two fields alone; reconciles leaving what the reader never
//! showed, deleting a key the map never held, and comparing values as JSON
//! writes them; canvas facets keeping what this build cannot read; and a batch
//! of several writers, and one whose second writer throws.
//!
//! `fixtures/content_write_cases.jsonl` holds each case as the engine's
//! recorder writes a writer row, answered by the TypeScript's engine with
//! `judge: "none"`. Then the writes the TypeScript's types refuse, which are
//! not answered here at all, and arguments built in an order JSON text cannot
//! carry.

#[cfg(test)]
mod support;
#[cfg(test)]
mod write_replay;

use support::{base64_decode, rows_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ExportMode, LoroDoc, WriteAnswer, Written, write_batch};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use write_replay::check_write;

const CASES: &str = include_str!("fixtures/content_write_cases.jsonl");

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
    assert_eq!(rows.len(), 49, "the cases held");
    assert_eq!(thrown, 17, "the cases a writer threw in");
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

/// A document whose body is `ab` and whose facets hold `c.d/v1`, written by
/// one peer so that two writes over it build on the same operations.
#[cfg(test)]
fn held() -> Vec<u8> {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).expect("a peer");
    doc.get_text("body").insert(0, "ab").expect("a body");
    doc.get_map("facets").insert("c.d/v1", 1).expect("a facet");
    doc.commit();
    doc.export(ExportMode::Snapshot).expect("a snapshot")
}

#[cfg(test)]
fn written(op: WriterName, args: Value) -> Option<Written> {
    write_batch(&held(), 3, &[Write { op, args }], WriteJudge::None)
}

#[cfg(test)]
fn answered(op: WriterName, args: Value) -> Option<WriteAnswer> {
    written(op, args).map(|done| done.answer)
}

#[cfg(test)]
fn run(index: Value, remove: Value, insert: Value) -> Value {
    let runs =
        Value::Seq(vec![object(&[("index", index), ("remove", remove), ("insert", insert)])]);
    object(&[("text", text("body")), ("runs", runs)])
}

#[test]
#[cfg(test)]
fn what_the_typescript_types_refuse_is_not_answered() {
    let nothing = Value::Map(Vec::new());
    let refused: Vec<(WriterName, Value)> = vec![
        (WriterName::WriteMarkdownBody, object(&[("body", number(1.0))])),
        (WriterName::SpliceText, object(&[("text", text("body")), ("runs", text("r"))])),
        (WriterName::SpliceText, object(&[("text", number(1.0)), ("runs", Value::Seq(vec![]))])),
        (WriterName::SpliceText, run(number(0.5), number(0.0), text(""))),
        (WriterName::SpliceText, run(number(-1.0), number(0.0), text(""))),
        (WriterName::SpliceText, run(number(4_294_967_296.0), number(0.0), text(""))),
        (WriterName::SpliceText, run(number(0.0), text("1"), text(""))),
        (WriterName::SpliceText, run(number(0.0), number(0.0), number(1.0))),
        (WriterName::WriteDocumentKind, object(&[("kind", Value::Null)])),
        (WriterName::WriteFacets, object(&[("facets", Value::Seq(vec![]))])),
        (WriterName::WriteCoreFacets, nothing.clone()),
        (WriterName::WriteTrustFacets, object(&[("trust", text("t"))])),
        (WriterName::WriteTrustFacets, nothing.clone()),
        (WriterName::WriteTrustFacets, object(&[("trust", object(&[("generated", Value::Null)]))])),
        (
            WriterName::WriteTrustFacets,
            object(&[("trust", object(&[("verified", nothing.clone())]))]),
        ),
        (
            WriterName::WriteTrustFacets,
            object(&[("trust", object(&[("verified", Value::Seq(vec![number(1.0)]))]))]),
        ),
        (WriterName::ReconcileFacets, object(&[("next", nothing.clone())])),
        (WriterName::ReconcileFacets, object(&[("prev", nothing.clone())])),
        (
            WriterName::ReconcileCoreFacets,
            object(&[("prev", text("p")), ("next", nothing.clone())]),
        ),
        (WriterName::ReconcileCoreFacets, object(&[("prev", Value::Null)])),
        (WriterName::WriteCanvasFacetsField, object(&[("next", text("n"))])),
    ];
    for (op, args) in refused {
        assert_eq!(answered(op, args.clone()), None, "{op:?} {args:?}");
    }
}

#[test]
#[cfg(test)]
fn a_run_at_the_widest_offset_is_answered_as_npm_loro_crdt_refuses_it() {
    let widest = run(number(f64::from(u32::MAX)), number(0.0), text("x"));
    assert_eq!(answered(WriterName::SpliceText, widest), Some(WriteAnswer::Thrown("string")));
    let inside = run(number(1.0), number(1.0), text("x"));
    let Some(WriteAnswer::Applied(applied)) = answered(WriterName::SpliceText, inside) else {
        panic!("a run inside the text applies");
    };
    assert!(applied.local_update.is_some(), "the run wrote");
}

/// What a write left: its update and the document's deep value.
#[cfg(test)]
fn outcome(written: Option<Written>) -> (Option<String>, Value) {
    let done = written.expect("answered");
    let WriteAnswer::Applied(applied) = done.answer else { panic!("applied") };
    (applied.local_update, whiteboard_crdt::deep_value(&done.doc))
}

#[test]
#[cfg(test)]
fn an_argument_built_out_of_enumeration_order_is_written_in_it() {
    // JSON text read as `JSON.parse` reads it is in enumeration order already,
    // so the writer must order an argument built any other way itself.
    let written_order = object(&[("b", number(1.0)), ("2", text("two")), ("1", text("one"))]);
    let enumerated = object(&[("1", text("one")), ("2", text("two")), ("b", number(1.0))]);
    let as_written =
        outcome(written(WriterName::WriteFacets, object(&[("facets", written_order)])));
    let in_order = outcome(written(WriterName::WriteFacets, object(&[("facets", enumerated)])));
    assert!(as_written.0.is_some());
    assert_eq!(as_written, in_order);
}

#[test]
#[cfg(test)]
fn a_reconcile_compares_nested_values_in_enumeration_order() {
    // `{"b":1,"1":2}` and `{"1":2,"b":1}` are one object to JavaScript, so a
    // reconcile between them over a bucket holding neither writes nothing.
    let facet = |pairs: &[(&str, Value)]| object(&[("c.d/v1", object(pairs))]);
    let prev = facet(&[("b", number(1.0)), ("1", number(2.0))]);
    let next = facet(&[("1", number(2.0)), ("b", number(1.0))]);
    let args = object(&[("prev", prev), ("next", next)]);
    let (update, _) = outcome(written(WriterName::ReconcileFacets, args));
    assert_eq!(update, None);
    let core = object(&[("type", text("t"))]);
    let args = object(&[("prev", core.clone()), ("next", core)]);
    let (update, _) = outcome(written(WriterName::ReconcileCoreFacets, args));
    assert_eq!(update, None, "a core field the caller read and kept is not written");
}

#[test]
#[cfg(test)]
fn a_hosted_content_write_is_not_answered() {
    let hosted = object(&[("body", text("x")), ("documentId", text("D"))]);
    assert_eq!(answered(WriterName::WriteMarkdownBody, hosted), None);
    assert!(write_batch(&base64_decode("AAAA"), 3, &[], WriteJudge::None).is_none());
}
