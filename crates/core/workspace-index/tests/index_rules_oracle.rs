//! The index's pure rules against the recorded answers of the TypeScript.
//!
//! `packages/workspace-index/src/oracle/index-rules.jsonl` is that recording,
//! frozen. This replays every row whose input is plain values: the rules over
//! a node list, a name, a path, trash rows and a found document, and the reads
//! over a workspace record's snapshot bytes. The writes over a record are not
//! ported, so they are counted and skipped by op name, and every op must be in
//! one of the two ledgers below with its row count, so a recorder change that
//! drops or adds rows fails here. A write row also holds what the keeper stored
//! after it: the record's deep value with its container ids, its version vector
//! (which counts the operations the write appended, so the Rust writers must
//! append the same ones), the saves and the blobs left.

mod support;

use serde_json::{Value as Json, json};
use std::collections::BTreeMap;
use support::{entry_json, ok, record_answer, restore_answer, write_answer};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_workspace_index::{
    BlobRef, DisplayNameTaken, Found, NamedKind, Node, TrashEntry, distinct_unnamed_path, entry_of,
    first_free_segment, is_named_by_another_row, move_collision, refuse_moved_name,
    refuse_sibling_document_name, same_display_name,
};

const RECORDING: &str =
    include_str!("../../../../packages/workspace-index/src/oracle/index-rules.jsonl");

/// The ops replayed here, with the rows the recording holds of each.
const REPLAYED: &[(&str, usize)] = &[
    ("firstFreeSegment", 69),
    ("moveCollision", 60),
    ("sameDisplayName", 135),
    ("refuseSiblingDocumentName", 100),
    ("refuseMovedName", 60),
    ("distinctUnnamedPath", 48),
    ("isNamedByAnotherRow", 6),
    ("entryOf", 104),
    ("restorableTrashDocuments", 86),
    ("resolveDocument", 27),
    ("listTrash", 20),
    ("resolveDocumentById", 16),
    ("listDocuments", 9),
    ("listFolderNames", 8),
    ("listPinnedDocuments", 8),
    ("setDocumentPinned", 24),
    ("setFolderName", 28),
    ("setDocumentName", 58),
    ("createDocument", 76),
    ("moveDocument", 56),
    ("deleteDocument", 31),
    ("purgeTrashEntry", 24),
    ("restoreDocument", 52),
];

/// The ops not replayed, with their rows: the index's writes over a record's
/// snapshot bytes that are not ported yet.
const DEFERRED: &[(&str, usize)] = &[("duplicateDocument", 28)];

fn str_of(row: &Json, key: &str) -> Option<String> {
    row[key].as_str().map(str::to_owned)
}

fn nodes_of(row: &Json) -> Vec<Node> {
    row["nodes"].as_array().map(|nodes| nodes.iter().map(node_of).collect()).unwrap_or_default()
}

fn node_of(node: &Json) -> Node {
    if node["type"] == "folder" {
        Node {
            kind: NamedKind::Folder,
            path: str_of(node, "path").unwrap_or_default(),
            name: str_of(node, "name"),
            document_id: None,
        }
    } else {
        Node {
            kind: NamedKind::Document,
            path: str_of(node, "path").unwrap_or_default(),
            name: str_of(&node["meta"], "name"),
            document_id: str_of(&node["meta"], "documentId"),
        }
    }
}

/// The nodes `isSelfOrDescendant(node.path, from)` selects, as the recorder does.
fn moving_of(nodes: &[Node], from: &str) -> Vec<Node> {
    nodes
        .iter()
        .filter(|node| {
            node.path == from || node.path.strip_prefix(from).is_some_and(|r| r.starts_with('/'))
        })
        .cloned()
        .collect()
}

fn trash_of(entry: &Json) -> TrashEntry {
    TrashEntry {
        document_id: str_of(entry, "documentId").unwrap_or_default(),
        blob: BlobRef {
            algorithm: str_of(&entry["blob"], "algorithm").unwrap_or_default(),
            digest_hex: str_of(&entry["blob"], "digestHex").unwrap_or_default(),
        },
    }
}

fn kind_name(kind: NamedKind) -> &'static str {
    match kind {
        NamedKind::Document => "document",
        NamedKind::Folder => "folder",
    }
}

fn refusal(taken: &DisplayNameTaken) -> Json {
    json!({
        "err": "DisplayNameTakenError",
        "fields": {
            "kind": kind_name(taken.kind),
            "path": taken.path,
            "displayName": taken.display_name,
            "name": "DisplayNameTakenError",
        },
    })
}

fn refused(result: Result<(), DisplayNameTaken>) -> Json {
    result.map_or_else(|taken| refusal(&taken), |()| ok(Json::Null))
}

fn taken_set(row: &Json) -> Vec<String> {
    let base = row["base"].as_str().unwrap_or_default();
    let mut held: Vec<String> = row["taken"]
        .as_array()
        .map(|taken| taken.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let through = row["takenThrough"].as_u64().unwrap_or(1);
    held.extend((2..=through).map(|n| format!("{base}-{n}")));
    held
}

fn found_of(found: &Json) -> Found {
    Found {
        document_id: str_of(found, "documentId").unwrap_or_default(),
        path: str_of(found, "path").unwrap_or_default(),
        kind: str_of(found, "kind"),
        name: str_of(found, "name"),
        shadowed: found["shadowed"].as_bool(),
        created_at: found["createdAt"].as_f64(),
        updated_at: found["updatedAt"].as_f64(),
        content_digest: str_of(found, "contentDigest").unwrap_or_default(),
    }
}

/// `entryOf`'s answer in the recorder's shape.
fn entry_answer(found: &Json) -> Json {
    entry_of(&found_of(found))
        .map_or_else(|_| json!({ "err": "RangeError" }), |e| ok(entry_json(&e)))
}

/// What the Rust port answers for one pure row, in the recorder's answer shape.
fn answer(row: &Json) -> Option<Json> {
    let nodes = nodes_of(row);
    let from = row["from"].as_str().unwrap_or_default();
    let to = row["to"].as_str().unwrap_or_default();
    let path = row["path"].as_str().unwrap_or_default();
    Some(match row["op"].as_str()? {
        "firstFreeSegment" => {
            let held = taken_set(row);
            let base = row["base"].as_str().unwrap_or_default();
            ok(first_free_segment(base, |s| held.iter().any(|h| h == s))
                .map_or(Json::Null, Json::from))
        }
        "moveCollision" => {
            let moving = moving_of(&nodes, from);
            ok(move_collision(&nodes, &moving, from, to).map_or(Json::Null, Json::from))
        }
        "sameDisplayName" => {
            ok(same_display_name(row["current"].as_str(), row["next"].as_str().unwrap_or_default()))
        }
        "refuseSiblingDocumentName" => refused(refuse_sibling_document_name(
            &nodes,
            path,
            row["name"].as_str().unwrap_or_default(),
            row["documentId"].as_str(),
        )),
        "refuseMovedName" => {
            let moving = moving_of(&nodes, from);
            refused(refuse_moved_name(&nodes, &moving, from, to))
        }
        "distinctUnnamedPath" => ok(distinct_unnamed_path(&nodes, path)),
        "isNamedByAnotherRow" => {
            let rows: Vec<TrashEntry> = row["rows"].as_array()?.iter().map(trash_of).collect();
            ok(is_named_by_another_row(&rows, &trash_of(&row["entry"])))
        }
        "entryOf" => entry_answer(&row["found"]),
        "restorableTrashDocuments" => restore_answer(row),
        _ => return record_answer(row),
    })
}

/// Replays a write row and holds every part of what the keeper stored to the recording.
fn check_write(row: &Json) -> bool {
    let Some(got) = write_answer(row) else { return false };
    let why = format!("{} ({})", row["id"], row["tag"]);
    assert_eq!(got.result, row["result"], "{why}: result");
    assert_eq!(got.minted, row["mint"].as_array().map_or(0, Vec::len), "{why}: ids minted");
    assert_eq!(Json::from(got.saves), row["saves"], "{why}: saves");
    assert_eq!(got.vv, row["vv"], "{why}: version vector");
    if !row["deep"].is_null() {
        assert_eq!(got.deep.as_ref(), Some(&row["deep"]), "{why}: stored record");
    }
    assert_eq!(json!(got.blobs), row["blobsAfter"], "{why}: blobs left");
    true
}

#[test]
fn every_recorded_row_is_answered_as_the_typescript_answered_it() {
    let mut replayed: BTreeMap<String, usize> = BTreeMap::new();
    let mut deferred: BTreeMap<String, usize> = BTreeMap::new();
    for line in RECORDING.lines() {
        let row: Json = serde_json::from_str(line).expect("a recorded line");
        let op = row["op"].as_str().expect("an op").to_owned();
        let held = match answer(&row) {
            Some(got) => {
                assert_eq!(got, row["result"], "{} ({})", row["id"], row["tag"]);
                true
            }
            None => check_write(&row),
        };
        *(if held { &mut replayed } else { &mut deferred }).entry(op).or_default() += 1;
    }
    let ledger = |rows: &[(&str, usize)]| -> BTreeMap<String, usize> {
        rows.iter().map(|&(op, n)| (op.to_owned(), n)).collect()
    };
    assert_eq!(replayed, ledger(REPLAYED), "the rows replayed, by op");
    assert_eq!(deferred, ledger(DEFERRED), "the rows not replayed, by op");
}
