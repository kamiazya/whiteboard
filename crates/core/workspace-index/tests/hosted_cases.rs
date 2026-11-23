//! The engine's reads over a workspace record, for the arrangements the
//! recording lacks, against the answers the TypeScript gave for them: a
//! compaction stamp at and past the safe-integer bounds, a hosted document
//! whose node holds something other than the container a reader opens at one
//! of its keys, and every argument a hosted read is asked with beside the
//! document it names.
//!
//! `fixtures/hosted_cases.jsonl` holds each record's bytes (a row with a
//! `snapshot`) and each read of it with the TypeScript's answer (`expect`). A
//! read this crate leaves to the caller answers `None`; which do is a ledger,
//! asserted exactly, so an answer cannot quietly become undecided.

#[cfg(test)]
#[path = "../../crdt/tests/support/mod.rs"]
#[expect(dead_code, reason = "the shared helpers are each used by some of the recordings' tests")]
mod support;

use std::collections::BTreeMap;
use support::{base64_decode, first_difference, model_of, rows_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::import_bytes;
use whiteboard_model::crdt::{Query, QueryName};
use whiteboard_workspace_index::answer_workspace_query;

const CASES: &str = include_str!("fixtures/hosted_cases.jsonl");

/// The reads left to the caller, by query: the ones whose arguments the
/// TypeScript's reader refuses (its refusal is its own), and the ones over a
/// node holding the wrong kind at a key where the read opens more than one
/// key, whose first refusal depends on the order the reader opens them in.
/// Eight of each are the refused arguments; the rest are the wrongly held keys
/// of a read that opens several (two cases per key: a scalar, another kind).
const UNDECIDED: &[(&str, usize)] = &[
    ("annotations", 8 + 4),
    ("bodyDelta", 8),
    ("commentThreads", 8),
    ("contentDigest", 8),
    ("coreFacets", 8 + 4),
    ("documentContent", 8 + 16),
    ("documentContentWithTags", 8 + 16),
    ("documentKind", 8),
    ("edgeLocks", 8),
    ("facets", 8),
    ("imageRefIds", 8 + 14),
    ("markdownBody", 8 + 6),
    ("nodeLocks", 8),
    ("proposals", 8),
    ("retiredCommentRows", 8),
    ("retiredStoredShape", 8 + 10),
    ("spatialCanvas", 8 + 10),
    ("spatialNodeCount", 8),
    ("stateSize", 8),
    ("threadMarks", 8),
    ("threadMessageCounts", 8),
    ("trustFacets", 8 + 4),
];

#[test]
fn every_case_is_answered_as_the_typescript_answered_it() {
    let rows = rows_of(CASES);
    let records: BTreeMap<&str, Vec<u8>> = rows
        .iter()
        .filter_map(|row| Some((row["name"].as_str()?, base64_decode(row["snapshot"].as_str()?))))
        .collect();
    let mut undecided: BTreeMap<String, usize> = BTreeMap::new();
    let mut differ: Vec<String> = Vec::new();
    for row in rows.iter().filter(|row| row.get("expect").is_some()) {
        let name = row["name"].as_str().expect("a name");
        let op = row["query"].as_str().expect("a query");
        let query = Query {
            query: QueryName::from_wire(op).expect("a query the contract names"),
            args: row.get("args").map(model_of),
        };
        let held = &records[row["doc"].as_str().expect("a record")];
        let doc = import_bytes(held).unwrap_or_else(|e| panic!("{name}: {e}"));
        match answer_workspace_query(&doc, &query) {
            Some(answer) => differ.extend(
                first_difference("", &answer.value, &model_of(&row["expect"]))
                    .map(|found| format!("{name}: {found}")),
            ),
            None => *undecided.entry(op.to_owned()).or_default() += 1,
        }
    }
    assert_eq!(differ, Vec::<String>::new(), "answers that differ from the TypeScript's");
    let ledger: BTreeMap<String, usize> =
        UNDECIDED.iter().map(|&(op, n)| (op.to_owned(), n)).collect();
    assert_eq!(undecided, ledger, "the reads left to the caller, by query");
}
