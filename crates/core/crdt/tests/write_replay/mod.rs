//! Replaying a writer row: the batch applied to the bytes before it, held to
//! the answer the TypeScript's engine gave and the document it left, read off
//! a snapshot imported afresh as the recorder reads it.

use crate::support::{assert_same, base64_decode, model_of, pairs_of, without_proto};
use serde_json::Value as Json;
use whiteboard_crdt::{
    ExportMode, LoroDoc, WriteAnswer, Written, deep_value, deep_value_with_id, frontier_pairs,
    import_bytes, version_pairs, write_batch,
};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};

/// Holds the state `doc` shows to the one the row recorded, both read off a
/// snapshot imported afresh, as the recorder reads it.
pub(crate) fn check_state(id: &str, doc: &LoroDoc, row: &Json) {
    assert_same(
        &format!("{id} deep value"),
        &without_proto(&deep_value(doc)).0,
        &model_of(&row["deep"]),
    );
    assert_same(
        &format!("{id} container ids"),
        &without_proto(&deep_value_with_id(doc)).0,
        &model_of(&row["ids"]),
    );
    assert_eq!(version_pairs(doc), pairs_of(&row["vv"]), "{id} version vector");
    assert_eq!(frontier_pairs(doc), pairs_of(&row["frontiers"]), "{id} frontiers");
}

/// A writer row's batch as written, key order kept: a map value's keys are
/// inserted into loro in the order the writer's object holds them.
fn batch_of(line: &str) -> Vec<Write> {
    let row = whiteboard_model::json::parse(line).expect("a recorded line");
    let Some(Value::Seq(batch)) = field(&row, "batch") else { panic!("a batch") };
    batch
        .iter()
        .map(|write| {
            let Some(Value::String(op)) = field(write, "op") else { panic!("an op") };
            let op = WriterName::from_wire(op).expect("a writer");
            Write { op, args: field(write, "args").cloned().unwrap_or_default() }
        })
        .collect()
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    let Value::Map(entries) = value else { return None };
    entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// The update bytes, held exactly on wasm32, the target npm loro-crdt is built
/// for. A map value is a hash map in loro whose order follows the width of
/// `usize`, so natively the same operations write its keys in another order:
/// there the update must be as long, and import onto `before` to the same
/// operations and the same document as the recorded one.
fn check_update(id: &str, before: &[u8], actual: &str, recorded: &str) {
    if cfg!(target_arch = "wasm32") || actual == recorded {
        assert_eq!(actual, recorded, "{id} local update");
        return;
    }
    let (actual, recorded) = (base64_decode(actual), base64_decode(recorded));
    assert_eq!(actual.len(), recorded.len(), "{id} local update length");
    let onto = |update: &[u8]| {
        let doc = import_bytes(before).expect("the bytes before");
        let from = doc.oplog_vv();
        doc.import(update).unwrap_or_else(|e| panic!("{id}: {e}"));
        let json = doc.export_json_updates(&from, &doc.oplog_vv()).expect("the operations");
        let ops = serde_json::to_value(json).expect("the operations as JSON");
        (ops, deep_value_with_id(&doc), version_pairs(&doc), frontier_pairs(&doc))
    };
    assert_eq!(onto(&actual), onto(&recorded), "{id} local update's operations");
}

/// What a write answered, as the engine's result writes it.
fn result_of(id: &str, before: &[u8], written: &Written, recorded: &Json) {
    match &written.answer {
        WriteAnswer::Thrown(class) => assert_eq!(recorded["err"], *class, "{id} refusal"),
        WriteAnswer::Applied(applied) => {
            let ok = &recorded["ok"];
            assert_eq!(ok["outcome"], "applied", "{id} outcome");
            assert_eq!(ok["changed"], serde_json::json!(applied.changed), "{id} changed");
            match (&applied.local_update, ok["localUpdate"].as_str()) {
                (Some(actual), Some(held)) => check_update(id, before, actual, held),
                (None, None) => {}
                (actual, held) => panic!("{id} local update: {actual:?} against {held:?}"),
            }
            assert!(applied.pending.is_none() && applied.root.is_none(), "{id} extra fields");
        }
    }
}

/// Replays a writer row; `false` when the Rust engine does not answer it. The
/// row was judged by the text limits; one the judge refused is not replayed,
/// and for every other the judge passed, so the unjudged write answers it.
pub(crate) fn check_write(id: &str, row: &Json, line: &str) -> bool {
    if row["result"]["ok"]["outcome"] == "refused" {
        return false;
    }
    let before = base64_decode(row["before"].as_str().expect("bytes"));
    let peer = row["peer"].as_str().and_then(|p| p.parse().ok()).expect("a peer");
    let Some(written) = write_batch(&before, peer, &batch_of(line), WriteJudge::None) else {
        return false;
    };
    result_of(id, &before, &written, &row["result"]);
    let snapshot = written.doc.export(ExportMode::Snapshot).expect("a snapshot");
    check_state(id, &import_bytes(&snapshot).expect("the snapshot"), row);
    true
}
