//! The spatial-canvas writers over documents written here, for the arrangements
//! the recording lacks: a removal's sweep of the edges and lines anchored on a
//! node and their locks, a retired edge refusing a removal, geometry the
//! writer refuses, locks set to what they hold, a resync over stale elements,
//! a batch's deferred sweep and its dispatch of an unknown step, a reconcile
//! of canvas facets this build cannot read, repeated ids, a batch whose
//! second writer throws, a lock set to a number or an empty text, and a line
//! end of a kind other than a node's that still names one (the schema refuses
//! the line, so a removal leaves it).
//!
//! `fixtures/spatial_write_cases.jsonl` holds each case as the engine's
//! recorder writes a writer row: the bytes before, the peer, the batch, what
//! the TypeScript's engine answered with `judge: "none"`, and the document
//! after. Then geometry JSON cannot carry, and the writes the TypeScript's
//! types refuse, which are not answered here at all.

#[cfg(test)]
mod support;
#[cfg(test)]
mod write_replay;

use support::{base64_decode, rows_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{WriteAnswer, write_batch};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use write_replay::check_write;

const CASES: &str = include_str!("fixtures/spatial_write_cases.jsonl");

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
    assert_eq!(rows.len(), 28, "the cases held");
    assert_eq!(thrown, 8, "the cases a writer threw in");
}

#[cfg(test)]
fn object(entries: &[(&str, Value)]) -> Value {
    Value::Map(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
}

#[cfg(test)]
fn text(s: &str) -> Value {
    Value::String(s.to_owned())
}

/// A document holding something at node `a`.
#[cfg(test)]
fn one_node() -> Vec<u8> {
    let doc = whiteboard_crdt::LoroDoc::new();
    doc.get_map("nodes").insert("a", "held").expect("a node");
    doc.commit();
    doc.export(whiteboard_crdt::ExportMode::Snapshot).expect("a snapshot")
}

#[test]
fn geometry_that_is_not_finite_is_a_type_error() {
    // The TypeScript's engine, handed NaN and either infinity as `x` directly,
    // throws `TypeError` from `nodeToFields` for each.
    for x in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let node = object(&[
            ("id", text("n")),
            ("x", Value::Number(x)),
            ("y", Value::Number(0.0)),
            ("width", Value::Number(1.0)),
            ("height", Value::Number(1.0)),
        ]);
        let args = object(&[("node", node)]);
        let answer = answered(WriterName::WriteSpatialNode, args, WriteJudge::None);
        assert_eq!(answer, Some(WriteAnswer::Thrown("TypeError")), "x = {x}");
    }
}

#[cfg(test)]
fn answered(op: WriterName, args: Value, judge: WriteJudge) -> Option<WriteAnswer> {
    write_batch(&one_node(), 3, &[Write { op, args }], judge).map(|written| written.answer)
}

#[test]
#[cfg(test)]
fn what_the_typescript_types_refuse_is_not_answered() {
    let unjudged = WriteJudge::None;
    let node = object(&[("id", Value::Number(1.0)), ("x", Value::Number(0.0))]);
    assert_eq!(answered(WriterName::WriteSpatialNode, object(&[("node", node)]), unjudged), None);
    let nodes = object(&[("nodes", text("a")), ("edges", Value::Seq(vec![]))]);
    assert_eq!(
        answered(WriterName::WriteSpatialCanvas, object(&[("canvas", nodes)]), unjudged),
        None
    );
    let edge = object(&[("id", text("e")), ("from", object(&[("node", text("a"))]))]);
    assert_eq!(answered(WriterName::WriteSpatialEdge, object(&[("edge", edge)]), unjudged), None);
    assert_eq!(answered(WriterName::DeleteSpatialNode, object(&[]), unjudged), None);
    assert_eq!(answered(WriterName::SetNodeLock, Value::Null, unjudged), None);
    let steps = object(&[("steps", Value::Seq(vec![Value::Null]))]);
    assert_eq!(answered(WriterName::WithSpatialBatch, steps, unjudged), None);
    let prev = object(&[("nodes", Value::Seq(vec![])), ("edges", Value::Seq(vec![]))]);
    let canvases = object(&[("prev", prev.clone()), ("next", object(&[("nodes", Value::Null)]))]);
    assert_eq!(answered(WriterName::ReconcileSpatialCanvas, canvases, unjudged), None);
}

#[test]
#[cfg(test)]
fn a_text_judged_hosted_or_unported_write_is_not_answered() {
    let id = object(&[("id", text("a"))]);
    assert!(answered(WriterName::DeleteSpatialNode, id.clone(), WriteJudge::None).is_some());
    assert_eq!(answered(WriterName::DeleteSpatialNode, id, WriteJudge::Text), None);
    let hosted = object(&[("id", text("a")), ("documentId", text("D"))]);
    assert_eq!(answered(WriterName::DeleteSpatialNode, hosted, WriteJudge::None), None);
    let thread = object(&[("thread", text("x"))]);
    assert_eq!(answered(WriterName::WriteCommentThread, thread, WriteJudge::None), None);
    assert!(write_batch(&base64_decode("AAAA"), 3, &[], WriteJudge::None).is_none());
}
