//! `whiteboard-crdt`'s writers naming a document hosted on a workspace tree
//! node, for the arrangements the recording lacks, against what the
//! TypeScript's engine answered for them: a node holding none of its content
//! containers (each write opens them, in the TypeScript's order), a node
//! holding a scalar or another kind of container at its content keys
//! (`UnreadableDocumentContentError`), a node still holding the comment plane
//! before threads, an id naming no document (`Error`), a text name a root
//! refuses and a node takes, a batch writing two documents, and
//! `reconcileDocContent`, which a `documentId` does not host.
//!
//! `fixtures/hosted_write_cases.jsonl` holds each record's bytes (a row with
//! a `base`'s `snapshot`) and each batch in the recorder's shape: the result,
//! and the deep value, container ids, version vector and frontiers after it.

#[cfg(test)]
#[path = "../../crdt/tests/support/mod.rs"]
mod support;
#[cfg(test)]
#[path = "../../crdt/tests/write_replay/mod.rs"]
#[expect(
    dead_code,
    reason = "the replay of a writer this crate does not answer is the crdt crate's"
)]
mod write_replay;

use std::collections::BTreeMap;
use support::rows_of;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::crdt::WriteJudge;
use whiteboard_workspace_index::write_workspace_batch;
use write_replay::check_write_with;

const CASES: &str = include_str!("fixtures/hosted_write_cases.jsonl");
const RECORDED_NOW: f64 = 1_700_000_000_000.0;

/// How the TypeScript answered the cases: thrown, by class, or applied with
/// an update or without one. A count proves each arrangement reached.
const ANSWERS: &[(&str, usize)] = &[
    ("Error", 6),
    ("RetiredCommentPlaneError", 1),
    ("UnreadableDocumentContentError", 70),
    ("applied", 116),
    ("unchanged", 35),
];

#[cfg(test)]
fn answer_of(row: &serde_json::Value) -> String {
    match row["result"]["err"].as_str() {
        Some(class) => class.to_owned(),
        None if row["result"]["ok"]["localUpdate"].is_string() => "applied".to_owned(),
        None => "unchanged".to_owned(),
    }
}

#[test]
fn every_case_is_answered_as_the_typescript_answered_it() {
    let rows = rows_of(CASES);
    let lines: Vec<&str> = CASES.lines().filter(|line| !line.is_empty()).collect();
    let bases: BTreeMap<&str, &str> = rows
        .iter()
        .filter_map(|row| Some((row["base"].as_str()?, row.get("snapshot")?.as_str()?)))
        .collect();
    let write = |before: &[u8], peer: u64, batch: &[whiteboard_model::crdt::Write]| {
        write_workspace_batch(before, peer, batch, WriteJudge::None, RECORDED_NOW)
    };
    let mut answers: BTreeMap<String, usize> = BTreeMap::new();
    for (row, line) in rows.iter().zip(&lines).filter(|(row, _)| row.get("batch").is_some()) {
        let id = row["id"].as_str().expect("an id");
        let mut row = row.clone();
        row["before"] = bases[row["base"].as_str().expect("a base")].into();
        assert!(check_write_with(id, &row, line, &write), "{id}: not answered");
        *answers.entry(answer_of(&row)).or_default() += 1;
    }
    let ledger: BTreeMap<String, usize> =
        ANSWERS.iter().map(|&(answer, n)| (answer.to_owned(), n)).collect();
    assert_eq!(answers, ledger, "the cases, by answer");
}
