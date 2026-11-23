//! The engine's workspace writers of the record's planes, a document's meta
//! and its content, for the arrangements the recording lacks, replayed
//! exactly as the recording's rows are: each row holds the bytes before a
//! batch, the batch, the TypeScript engine's answer and the record after it.
//!
//! `fixtures/workspace_record_write_cases.jsonl` was taken from the real
//! engine (`createCrdtEngine`) under the recorder's pinned clock; `dup-foreign`
//! starts from bytes a Rust writer made, holding numbers npm loro-crdt never
//! stores (a whole double, a negative zero, an integer past 2^53).

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

use support::rows_of;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::crdt::WriteJudge;
use whiteboard_workspace_index::write_workspace_batch;
use write_replay::check_write_with;

const CASES: &str = include_str!("fixtures/workspace_record_write_cases.jsonl");
const RECORDED_NOW: f64 = 1_700_000_000_000.0;

/// The cases left to the caller: a content write that appends operations
/// under two roots (a body and a map), in an order only wasm32's hash map
/// knows.
const NOT_ANSWERED: &[&str] = &["content-two-roots", "dup-foreign"];

#[test]
fn every_case_is_answered_as_the_typescript_answered_it() {
    let write = |before: &[u8], peer: u64, batch: &[whiteboard_model::crdt::Write]| {
        write_workspace_batch(before, peer, batch, WriteJudge::None, RECORDED_NOW)
    };
    let rows = rows_of(CASES);
    assert!(rows.len() > 70, "{} cases", rows.len());
    let mut declined = Vec::new();
    for (row, line) in rows.iter().zip(CASES.lines().filter(|line| !line.is_empty())) {
        let id = row["id"].as_str().expect("an id");
        if !check_write_with(id, row, line, &write) {
            declined.push(id);
        }
    }
    assert_eq!(declined, NOT_ANSWERED);
}
