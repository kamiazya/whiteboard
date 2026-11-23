//! The CRDT document engine against the recorded answers of the TypeScript.
//!
//! `packages/loro-adapter/src/oracle/crdt-engine.jsonl` is that recording,
//! frozen: every query asked of each document, each hosted and standalone, and
//! writer batches with the bytes before them and the state after. This replays
//! the rows the Rust engine answers and holds each to the recording field by
//! field; every other op is in the ledger below with its row count, so a
//! recorder change that drops or adds rows fails here, and a port moves its
//! ops from one ledger to the other.
//!
//! Every query row names its document by the `open` row holding its bytes, and
//! was recorded against a handle opened for that read alone, so a replay opens
//! the bytes afresh for each row.

#[cfg(test)]
mod support;

use serde_json::Value as Json;
use std::collections::BTreeMap;
use support::{assert_same, base64_decode, model_of, pairs_of, rows_of, without_proto};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{
    CONTENT_QUERIES, answer_content_query, deep_value, deep_value_with_id, frontier_pairs,
    import_bytes, version_pairs,
};
use whiteboard_model::crdt::{Query, QueryName};

const RECORDING: &str =
    include_str!("../../../../packages/loro-adapter/src/oracle/crdt-engine.jsonl");

/// The ops replayed here, with the rows the recording holds of each.
const REPLAYED: &[(&str, usize)] = &[
    ("open", 178),
    ("documentKind", 178),
    ("nodeLocks", 178),
    ("edgeLocks", 178),
    ("markdownBody", 178),
    ("bodyDelta", 178),
    ("facets", 178),
    ("retiredStoredShape", 178),
    ("retiredCommentRows", 178),
    ("documentContent", 178),
    ("documentContentWithTags", 178),
    ("spatialCanvas", 178),
    ("spatialNodeCount", 178),
    ("coreFacets", 178),
    ("trustFacets", 178),
    ("annotations", 178),
    ("commentThreads", 178),
    ("threadMessageCounts", 178),
    ("threadMarks", 178),
    ("proposals", 178),
    ("imageRefIds", 178),
];

/// The ops not replayed, with their rows: a query a document hosted on a
/// workspace tree node asks is listed as `<query>@node`.
const DEFERRED: &[(&str, usize)] = &[
    ("stateSize", 178),
    ("contentDigest", 178),
    ("textLimitBreach", 178),
    ("documents", 178),
    ("nodes", 178),
    ("meta", 178),
    ("pinned", 178),
    ("trash", 178),
    ("folderNames", 178),
    ("unreadableNodes", 178),
    ("removedSince", 178),
    ("touchedSince", 178),
    ("organisationChangedSince", 178),
    ("fileReferences", 178),
    ("workspaceDocumentEntry", 178),
    ("workspaceDocumentProjection", 178),
    ("containerPlace", 178),
    ("documentJudgement", 178),
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
    ("writeSpatialCanvas", 6),
    ("writeSpatialNode", 6),
    ("writeSpatialEdge", 6),
    ("deleteSpatialNode", 6),
    ("deleteSpatialEdge", 6),
    ("reconcileSpatialCanvas", 6),
    ("setNodeLock", 6),
    ("setEdgeLock", 6),
    ("withSpatialBatch", 6),
    ("writeMarkdownBody", 6),
    ("writeDocumentKind", 6),
    ("writeFacets", 6),
    ("writeCoreFacets", 6),
    ("writeTrustFacets", 4),
    ("reconcileFacets", 6),
    ("reconcileCoreFacets", 6),
    ("writeCanvasFacetsField", 6),
    ("writeCommentThread", 6),
    ("writeThreadMessage", 6),
    ("setCommentThreadStatus", 6),
    ("moveCommentThread", 6),
    ("markThreadPassages", 6),
    ("writeProposal", 6),
    ("setProposedChangeStatus", 6),
    ("withDocumentBatch", 6),
    ("reconcileDocContent", 6),
    ("writeWorkspaceDocumentContent", 6),
    ("writeDocumentContentAndName", 6),
    ("seedNameFromTitle", 6),
    ("createWorkspaceDocumentAtPath", 6),
    ("createWorkspaceDocument", 6),
    ("ensureFolderPath", 6),
    ("moveWorkspaceDocument", 6),
    ("moveWorkspaceNodeToPath", 6),
    ("setWorkspaceDocumentName", 6),
    ("setWorkspaceFolderName", 6),
    ("deleteWorkspaceDocument", 6),
    ("deleteWorkspaceNode", 6),
    ("deleteWorkspaceNodeAtPath", 6),
    ("setWorkspaceLastCompactedAt", 6),
    ("setWorkspacePinned", 6),
    ("recordTrashEntry", 6),
    ("updateWorkspaceDocumentMeta", 6),
    ("pruneEmptyFolders", 6),
    ("duplicateWorkspaceDocument", 6),
    ("seedNamesFromTitles", 6),
    ("stampEditedDocuments", 6),
    ("spliceText", 6),
    ("forgetTrashEntry", 6),
    ("reapplyFolderNames", 6),
];

#[cfg(test)]
fn query_of(row: &Json) -> Option<Query> {
    let name = QueryName::from_wire(row["op"].as_str()?)?;
    Some(Query { query: name, args: row.get("args").map(model_of) })
}

#[cfg(test)]
fn check_open(row: &Json) {
    let id = row["id"].as_str().expect("an id");
    let doc = import_bytes(&base64_decode(row["snapshot"].as_str().expect("bytes")))
        .unwrap_or_else(|e| panic!("{id}: {e}"));
    assert_same(
        &format!("{id} deep value"),
        &without_proto(&deep_value(&doc)).0,
        &model_of(&row["deep"]),
    );
    assert_same(
        &format!("{id} container ids"),
        &without_proto(&deep_value_with_id(&doc)).0,
        &model_of(&row["ids"]),
    );
    assert_eq!(version_pairs(&doc), pairs_of(&row["vv"]), "{id} version vector");
    assert_eq!(frontier_pairs(&doc), pairs_of(&row["frontiers"]), "{id} frontiers");
}

/// Replays a query row; `false` when the Rust engine does not answer it.
#[cfg(test)]
fn check_query(row: &Json, bytes: &BTreeMap<String, Vec<u8>>) -> bool {
    let Some(query) = query_of(row) else { return false };
    if !CONTENT_QUERIES.contains(&query.query) {
        return false;
    }
    let id = row["id"].as_str().expect("an id");
    let held = bytes.get(row["doc"].as_str().expect("a document")).expect("an open row");
    let doc = import_bytes(held).unwrap_or_else(|e| panic!("{id}: {e}"));
    let Some(answer) = answer_content_query(&doc, &query) else { return false };
    assert_same(&format!("{id} answer"), &answer.value, &model_of(&row["result"]));
    true
}

#[test]
fn every_recorded_row_is_answered_as_the_typescript_answered_it() {
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
    let mut deferred: BTreeMap<String, usize> = BTreeMap::new();
    for row in &rows {
        let mut op = row["op"].as_str().expect("an op").to_owned();
        let held = if op == "open" {
            check_open(row);
            true
        } else if row.get("doc").is_some() {
            let hosted = row["args"].get("documentId").is_some();
            let held = !hosted && check_query(row, &bytes);
            if hosted {
                op.push_str("@node");
            }
            held
        } else {
            false
        };
        *(if held { &mut replayed } else { &mut deferred }).entry(op).or_default() += 1;
    }
    let ledger = |rows: &[(&str, usize)]| -> BTreeMap<String, usize> {
        rows.iter().map(|&(op, n)| (op.to_owned(), n)).collect()
    };
    assert_eq!(replayed, ledger(REPLAYED), "the rows replayed, by op");
    assert_eq!(deferred, ledger(DEFERRED), "the rows not replayed, by op");
}

#[test]
fn the_recording_reaches_what_the_ledger_claims() {
    let rows = rows_of(RECORDING);
    assert!(rows.len() > 5000, "the recording held {} rows", rows.len());
    let refused = |op: &str| {
        rows.iter().filter(|r| r["op"] == op && r["result"].get("err").is_some()).count()
    };
    assert!(refused("markdownBody") > 0, "no refused body, so the refusal reached nothing");
    let named = rows
        .iter()
        .filter(|r| r["op"] == "retiredStoredShape" && r["result"]["ok"].is_string())
        .count();
    assert!(named > 5, "{named} retired shapes named");
}
