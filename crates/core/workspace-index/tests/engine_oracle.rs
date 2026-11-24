//! The document engine's reads over a workspace record, against the recorded
//! answers of the TypeScript.
//!
//! `packages/loro-adapter/src/oracle/crdt-engine.jsonl` is the recording; its
//! content queries over a document of its own are replayed by `whiteboard-crdt`.
//! This replays what only a workspace record answers: what the record lists,
//! what the operations after a version touched, removed or reorganised (each
//! row asks with no version, so of every operation the record kept), the images
//! it names, where a container sits, one document's entry and projection (each
//! row names no document or container, which the TypeScript refuses), and the
//! content queries of a document hosted on one of its tree nodes (listed
//! as `<query>@node`). Every op is in a ledger with its row count, so a recorder
//! change that drops or adds rows fails here.

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
use support::{assert_same, base64_decode, model_of, rows_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ENGINE_WRITERS, import_bytes};
use whiteboard_model::crdt::{Query, QueryName, WriteJudge, WriterName};
use whiteboard_workspace_index::{
    WORKSPACE_WRITERS, answer_workspace_query, write_workspace_batch,
};
use write_replay::check_write_with;

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
    ("removedSince", 178),
    ("touchedSince", 178),
    ("organisationChangedSince", 178),
    ("fileReferences", 178),
    ("workspaceDocumentEntry", 178),
    ("workspaceDocumentProjection", 178),
    ("containerPlace", 178),
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

/// The workspace writers replayed here, with the rows the recording holds of
/// each, and `whiteboard-crdt`'s writers naming a document hosted on one of
/// the record's tree nodes (`<writer>@node`). A writer row was recorded under
/// the pinned clock.
const WRITES_REPLAYED: &[(&str, usize)] = &[
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
    ("writeWorkspaceDocumentContent", 2),
    ("writeDocumentContentAndName", 2),
    ("seedNameFromTitle", 6),
    ("seedNamesFromTitles", 6),
    ("stampEditedDocuments", 6),
    ("setWorkspaceLastCompactedAt", 6),
    ("setWorkspacePinned", 6),
    ("recordTrashEntry", 6),
    ("updateWorkspaceDocumentMeta", 6),
    ("pruneEmptyFolders", 6),
    ("duplicateWorkspaceDocument", 4),
    ("forgetTrashEntry", 6),
    ("reapplyFolderNames", 6),
    ("writeSpatialCanvas@node", 2),
    ("writeSpatialNode@node", 2),
    ("writeSpatialEdge@node", 2),
    ("deleteSpatialNode@node", 2),
    ("deleteSpatialEdge@node", 2),
    ("reconcileSpatialCanvas@node", 2),
    ("setNodeLock@node", 2),
    ("setEdgeLock@node", 2),
    ("withSpatialBatch@node", 2),
    ("writeMarkdownBody@node", 2),
    ("writeDocumentKind@node", 3),
    ("writeFacets@node", 2),
    ("writeCoreFacets@node", 2),
    ("writeTrustFacets@node", 2),
    ("reconcileFacets@node", 2),
    ("reconcileCoreFacets@node", 2),
    ("writeCanvasFacetsField@node", 2),
    ("spliceText@node", 2),
    ("writeCommentThread@node", 3),
    ("writeThreadMessage@node", 2),
    ("setCommentThreadStatus@node", 2),
    ("moveCommentThread@node", 2),
    ("markThreadPassages@node", 3),
    ("writeProposal@node", 3),
    ("setProposedChangeStatus@node", 2),
    ("withDocumentBatch@node", 2),
];

/// The workspace writer rows not answered, with the rows of each: a content
/// write that appends operations under more than one root writes them in the
/// order wasm32's hash map holds the source's roots, which a native build
/// cannot know (`whiteboard_crdt::sync_node_content`).
const WRITES_DEFERRED: &[(&str, usize)] = &[
    ("writeWorkspaceDocumentContent", 4),
    ("writeDocumentContentAndName", 4),
    ("duplicateWorkspaceDocument", 2),
];

/// `RECORDED_NOW`, the clock the recorder pins `Date.now` to.
const RECORDED_NOW: f64 = 1_700_000_000_000.0;

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

/// The ledger entry of a writer row this crate answers: a workspace writer by
/// name, a crdt writer naming a hosted document as `<writer>@node`.
#[cfg(test)]
fn ledgered_writer(row: &serde_json::Value) -> Option<String> {
    row.get("batch")?;
    let op = row["op"].as_str().expect("an op");
    let name = WriterName::from_wire(op)?;
    if WORKSPACE_WRITERS.contains(&name) {
        return Some(op.to_owned());
    }
    let hosted = row["batch"][0]["args"].get("documentId").is_some();
    (hosted && ENGINE_WRITERS.contains(&name)).then(|| format!("{op}@node"))
}

#[test]
fn every_workspace_writer_row_is_answered_as_the_typescript_answered_it() {
    let mut replayed: BTreeMap<String, usize> = BTreeMap::new();
    let mut deferred: BTreeMap<String, usize> = BTreeMap::new();
    let write = |before: &[u8], peer: u64, batch: &[whiteboard_model::crdt::Write]| {
        write_workspace_batch(before, peer, batch, WriteJudge::None, RECORDED_NOW)
    };
    let rows = rows_of(RECORDING);
    for (row, line) in rows.iter().zip(RECORDING.lines().filter(|line| !line.is_empty())) {
        let Some(op) = ledgered_writer(row) else { continue };
        let held = check_write_with(row["id"].as_str().expect("an id"), row, line, &write);
        *(if held { &mut replayed } else { &mut deferred }).entry(op).or_default() += 1;
    }
    let ledger = |rows: &[(&str, usize)]| -> BTreeMap<String, usize> {
        rows.iter().map(|&(op, n)| (op.to_owned(), n)).collect()
    };
    assert_eq!(replayed, ledger(WRITES_REPLAYED), "the writer rows replayed, by op");
    assert_eq!(deferred, ledger(WRITES_DEFERRED), "the writer rows not answered, by op");
}
