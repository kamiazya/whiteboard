//! The engine's reads of a workspace record that take arguments or read its
//! history, for the arrangements the recording lacks (it asks each with no
//! arguments), against the answers the TypeScript gave for them: a document
//! named by its id or its path, shadowed, missing or below an unreadable node;
//! a projection over a scalar or bytes held at a content key; containers
//! inside, outside and above the tree, under a tree of another name, uncreated
//! or malformed; images named by a body or by a node the readers refuse; and
//! the since-readers after each kind of write, a delete that leaves a survivor
//! below included, one peer's writes past a version that holds another's, and
//! two peers' writes touching one document.
//!
//! `fixtures/record_read_cases.jsonl` holds each record's bytes (a row with a
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

const CASES: &str = include_str!("fixtures/record_read_cases.jsonl");

/// The reads left to the caller, by query. Seven are arguments the
/// TypeScript's schema refuses (its refusal is its own); five a version whose
/// peer is no canonical u64 or whose counter a loro version cannot hold
/// (npm loro-crdt refuses or wraps it in its own way: `-3` and `2^40` both read
/// as "every operation"). One is a projection holding bytes, which the
/// TypeScript writes as the state they import to, and one the file scan over a
/// node holding a scalar at a key the image read opens among several (as
/// `hosted_cases.rs` leaves it). One asks whether a compacted record was
/// reorganised by an edit under a node a delete took, whose creation the
/// compaction dropped: loro's arena still knows the node's container sits under
/// the tree, but no public call of the `loro` crate names a container's parent,
/// so the edit cannot be placed. The 33 `touchedSince` rows name every
/// operation of a record two peers wrote, touching more than one document:
/// the TypeScript lists them peer by peer in the order wasm32's hash map holds
/// the peers, and natively the same map listed peer 9 before peer 7 where the
/// TypeScript listed 7 first, so the order is not this build's to know.
const UNDECIDED: &[(&str, usize)] = &[
    ("containerPlace", 1),
    ("fileReferences", 1),
    ("organisationChangedSince", 3 + 1),
    ("removedSince", 2),
    ("touchedSince", 33),
    ("workspaceDocumentEntry", 4),
    ("workspaceDocumentProjection", 2),
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
