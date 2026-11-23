//! The document engine's reads over a workspace record, against the recorded
//! answers of the TypeScript.
//!
//! `packages/loro-adapter/src/oracle/crdt-engine.jsonl` is the recording; its
//! content queries over a document of its own are replayed by `whiteboard-crdt`.
//! This replays what only a workspace record answers: what the record lists,
//! and the content queries of a document hosted on one of its tree nodes (listed
//! as `<query>@node`). Every op is in a ledger with its row count, so a recorder
//! change that drops or adds rows fails here.

#[cfg(test)]
#[path = "../../crdt/tests/support/mod.rs"]
#[expect(dead_code, reason = "the shared helpers are each used by some of the recordings' tests")]
mod support;

use std::collections::BTreeMap;
use support::{assert_same, base64_decode, model_of, rows_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::import_bytes;
use whiteboard_model::crdt::{Query, QueryName};
use whiteboard_workspace_index::answer_workspace_query;

const RECORDING: &str =
    include_str!("../../../../packages/loro-adapter/src/oracle/crdt-engine.jsonl");

/// The ops replayed here, with the rows the recording holds of each.
const REPLAYED: &[(&str, usize)] = &[
    ("documents", 178),
    ("nodes", 178),
    ("meta", 178),
    ("pinned", 178),
    ("trash", 178),
    ("folderNames", 178),
    ("unreadableNodes", 178),
    ("documentKind@node", 16),
    ("documentContent@node", 16),
    ("documentContentWithTags@node", 16),
    ("spatialCanvas@node", 16),
    ("nodeLocks@node", 16),
    ("edgeLocks@node", 16),
    ("spatialNodeCount@node", 16),
    ("markdownBody@node", 16),
    ("bodyDelta@node", 16),
    ("coreFacets@node", 16),
    ("trustFacets@node", 16),
    ("facets@node", 16),
    ("annotations@node", 16),
    ("commentThreads@node", 16),
    ("threadMessageCounts@node", 16),
    ("threadMarks@node", 16),
    ("proposals@node", 16),
    ("imageRefIds@node", 16),
    ("retiredStoredShape@node", 16),
    ("retiredCommentRows@node", 16),
];

/// Replays a query row, `false` when the record's reads do not answer it.
#[cfg(test)]
fn check_query(row: &serde_json::Value, bytes: &BTreeMap<String, Vec<u8>>) -> bool {
    let Some(name) = QueryName::from_wire(row["op"].as_str().expect("an op")) else {
        return false;
    };
    let query = Query { query: name, args: row.get("args").map(model_of) };
    let id = row["id"].as_str().expect("an id");
    let held = bytes.get(row["doc"].as_str().expect("a document")).expect("an open row");
    let doc = import_bytes(held).unwrap_or_else(|e| panic!("{id}: {e}"));
    let Some(answer) = answer_workspace_query(&doc, &query) else { return false };
    assert_same(&format!("{id} answer"), &answer.value, &model_of(&row["result"]));
    true
}

#[test]
fn every_row_a_record_answers_is_answered_as_the_typescript_answered_it() {
    let rows = rows_of(RECORDING);
    let bytes: BTreeMap<String, Vec<u8>> = rows
        .iter()
        .filter(|row| row["op"] == "open")
        .map(|row| {
            let id = row["id"].as_str().expect("an id").to_owned();
            (id, base64_decode(row["snapshot"].as_str().expect("bytes")))
        })
        .collect();
    let mut replayed: BTreeMap<String, usize> = BTreeMap::new();
    for row in rows.iter().filter(|row| row.get("doc").is_some()) {
        let hosted = row["args"].get("documentId").is_some();
        let mut op = row["op"].as_str().expect("an op").to_owned();
        if check_query(row, &bytes) {
            if hosted {
                op.push_str("@node");
            }
            *replayed.entry(op).or_default() += 1;
        }
    }
    let ledger: BTreeMap<String, usize> =
        REPLAYED.iter().map(|&(op, n)| (op.to_owned(), n)).collect();
    assert_eq!(replayed, ledger, "the rows replayed, by op");
}
