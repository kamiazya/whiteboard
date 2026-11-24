//! `wb_facet_set` held to what the daemon answered over a note and a board.
//!
//! `packages/mcp-server/src/server/mcp/oracle/facet-set.jsonl` is recorded by
//! `facet-set.oracle.test.ts` beside it: its first row is the record (kept as
//! `W`, with the registry rows that address it, the handles a refusal may
//! name, the ids of its documents by name, and the replica and the instant
//! the recorder scripted the daemon with), the second the stored record
//! before any call, and every row after it one `tools/call`: the result the
//! TypeScript server drew, the activity it told the pages, the documents it
//! reported written, and the stored record after it when the call moved it
//! (its value, version vector and frontiers). Every answered row is compared
//! whole, its text byte for byte, and so is what it told and what it stored; a
//! row this crate leaves pending is named in [`PENDING`] and answered as a
//! pending tool. Pending rows come last in the recording, since the daemon
//! writes for them and nothing after them may read it.

use serde_json::{Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{deep_value, frontier_pairs, import_bytes, version_pairs};
use whiteboard_mcp::{Identity, OpsCatalogue, Server};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_ops::Ports;
use whiteboard_port_fakes::{
    FixedCaller, FixedClock, KeyedLock, MemoryRecordStore, MemoryRegistry, MemoryVersionStore,
    RecordingNotifier, RecordingObserver, SeqIdMint, block_on,
};
use whiteboard_ports::{WorkspaceEntry, WorkspaceRecordStore};

const CASES: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/facet-set.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/// The recorded calls this crate leaves pending: a write changing more than
/// one of a document's roots (whose order is an owner decision still open),
/// and a facet that takes a stencil, which reads the workspace's stencil
/// library.
const PENDING: &[&str] = &[
    "a tag beside two stored facets",
    "a stored payload of two keys beside a new facet",
    "a stored payload of several keys, a tag written",
    "facets and tags together on a note",
    "a stencil written",
    "a stencil nothing registered",
];

struct Fakes {
    records: MemoryRecordStore,
    registry: MemoryRegistry,
    caller: FixedCaller,
    versions: MemoryVersionStore,
    lock: KeyedLock,
    clock: FixedClock,
    mint: SeqIdMint,
    notifier: RecordingNotifier,
    observer: RecordingObserver,
}

/// The fakes are lent to the server, so the test reads what a call left.
impl Ports for &Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;
    type Lock = KeyedLock;
    type Clock = FixedClock;
    type Mint = SeqIdMint;
    type Notifier = RecordingNotifier;
    type Observer = RecordingObserver;

    fn records(&self) -> &MemoryRecordStore {
        &self.records
    }

    fn registry(&self) -> &MemoryRegistry {
        &self.registry
    }

    fn caller(&self) -> &FixedCaller {
        &self.caller
    }

    fn versions(&self) -> &MemoryVersionStore {
        &self.versions
    }

    fn lock(&self) -> &KeyedLock {
        &self.lock
    }

    fn clock(&self) -> &FixedClock {
        &self.clock
    }

    fn mint(&self) -> &SeqIdMint {
        &self.mint
    }

    fn notifier(&self) -> &RecordingNotifier {
        &self.notifier
    }

    fn observer(&self) -> &RecordingObserver {
        &self.observer
    }
}

#[cfg(test)]
fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key).map(|v| v.as_str().expect("a string").to_owned())
}

#[cfg(test)]
fn bytes(base64: &Value) -> Vec<u8> {
    base64_to_bytes(base64.as_str().expect("base64 text")).expect("base64")
}

#[cfg(test)]
fn entry(row: &Value) -> WorkspaceEntry {
    WorkspaceEntry {
        workspace_id: text(row, "workspaceId").expect("an id"),
        namespace: text(row, "namespace"),
        segment: text(row, "segment"),
    }
}

#[cfg(test)]
/// The store keeps a write by merging it into the record, as the keeper does.
fn merge(record: &[u8], update: &[u8]) -> Result<Vec<u8>, String> {
    let doc = import_bytes(record).map_err(|e| e.0)?;
    doc.import(update).map_err(|e| e.to_string())?;
    doc.export(whiteboard_crdt::ExportMode::Snapshot).map_err(|e| e.to_string())
}

#[cfg(test)]
fn fakes(record: &Value) -> Fakes {
    let registry = record["registry"]
        .as_array()
        .expect("registry rows")
        .iter()
        .fold(MemoryRegistry::new(), |registry, row| registry.holding(entry(row)));
    let known = record["known"].as_array().expect("known handles");
    let caller = FixedCaller::new()
        .in_namespace(record["callerNamespace"].as_str().expect("a namespace"))
        .knowing(known.iter().map(|h| h.as_str().expect("a handle").to_owned()).collect());
    let peer: u64 = record["peer"].as_str().expect("a peer").parse().expect("a peer id");
    Fakes {
        records: MemoryRecordStore::new()
            .holding(W, bytes(&record["snapshot"]))
            .merging_with(merge),
        registry,
        caller,
        versions: MemoryVersionStore::new(),
        lock: KeyedLock::new(),
        clock: FixedClock::new(record["mint"]["atMs"].as_f64().expect("milliseconds")),
        mint: SeqIdMint::one_peer(peer),
        notifier: RecordingNotifier::new(),
        observer: RecordingObserver::new(),
    }
}

#[cfg(test)]
/// A model value as JSON, every number a double, as [`doubles`] reads the
/// recording.
fn as_json(value: &whiteboard_model::Value) -> Value {
    use whiteboard_model::Value as Plain;
    match value {
        Plain::Null => Value::Null,
        Plain::Bool(flag) => Value::Bool(*flag),
        Plain::Number(n) => json!(n),
        Plain::String(text) => Value::from(text.as_str()),
        Plain::Seq(items) => Value::Array(items.iter().map(as_json).collect()),
        Plain::Map(entries) => {
            Value::Object(entries.iter().map(|(k, v)| (k.clone(), as_json(v))).collect())
        }
        Plain::BigInt(digits) => json!(digits.parse::<f64>().expect("digits")),
    }
}

#[cfg(test)]
/// A recorded value with every number read as a double, so an integer
/// `JSON.parse` wrote and the double a record holds compare by value.
fn doubles(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().expect("a number")),
        Value::Array(items) => Value::Array(items.iter().map(doubles).collect()),
        Value::Object(members) => {
            Value::Object(members.iter().map(|(k, v)| (k.clone(), doubles(v))).collect())
        }
        other => other.clone(),
    }
}

#[cfg(test)]
/// The stored record as the recorder reads it back.
fn stored(ports: &Fakes) -> Value {
    let held = block_on(ports.records.load(W)).expect("a load").expect("the record");
    let doc = import_bytes(&held).expect("a record");
    let pairs = |pairs: Vec<(String, i64)>| {
        Value::Array(pairs.into_iter().map(|(peer, counter)| json!([peer, counter])).collect())
    };
    doubles(&json!({
        "value": as_json(&deep_value(&doc)),
        "version": pairs(version_pairs(&doc)),
        "frontiers": pairs(frontier_pairs(&doc)),
    }))
}

#[cfg(test)]
/// What a call told the pages, as the recorder writes it.
fn activity(ports: &Fakes) -> Value {
    let told = ports.notifier.take_activity().into_iter().map(|told| {
        json!({
            "workspaceId": told.workspace_id,
            "documentId": told.document_id,
            "touched": {
                "nodes": told.touched.nodes,
                "edges": told.touched.edges,
                "lines": told.touched.lines,
                "comments": told.touched.comments,
            },
            "summary": told.summary,
        })
    });
    Value::Array(told.collect())
}

#[cfg(test)]
fn written(ports: &Fakes) -> Value {
    let told = ports.observer.take().into_iter().map(|written| {
        json!({
            "workspaceId": written.workspace_id,
            "documentId": written.document_id,
            "path": written.path,
        })
    });
    Value::Array(told.collect())
}

#[test]
fn every_recorded_call_is_answered_as_the_daemon_answered_it() {
    let mut lines = CASES.lines();
    let record: Value = serde_json::from_str(lines.next().expect("a record")).expect("JSON");
    let before: Value = serde_json::from_str(lines.next().expect("a start")).expect("JSON");
    let identity =
        Identity { name: "whiteboard".into(), version: "0".into(), instructions: String::new() };
    let held = fakes(&record);
    let ports = &held;
    let server = Server::new(identity, OpsCatalogue::new(ports));
    let mut expected = doubles(&before["record"]);
    assert_eq!(stored(ports), expected, "the record before any call");
    let (mut answered, mut pending, mut updated) = (0, 0, 0);
    for (id, line) in lines.enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        let case = row["case"].as_str().expect("a case");
        let message =
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": row["params"] });
        let answer = block_on(server.handle(&message)).expect("an answer");
        if PENDING.contains(&case) {
            assert_eq!(
                answer["error"]["message"],
                json!("Tool wb_facet_set not found"),
                "{case} is pending"
            );
            let _ = (ports.notifier.take_activity(), ports.observer.take());
            assert_eq!(stored(ports), expected, "{case}: a pending call writes nothing");
            pending += 1;
            continue;
        }
        assert_eq!(answer["result"], row["answer"], "{case}");
        assert_eq!(activity(ports), row["activity"], "{case}: what the pages were told");
        assert_eq!(written(ports), row["written"], "{case}: what was reported written");
        if let Some(moved) = row.get("record") {
            expected = doubles(moved);
        }
        assert_eq!(stored(ports), expected, "{case}: the stored record");
        answered += 1;
        updated += usize::from(row["answer"].get("structuredContent").is_some());
    }
    assert_eq!((answered, pending), (150, 6), "the recording's calls, answered and pending");
    assert_eq!(updated, 53, "the calls answered with documents");
}

#[cfg(test)]
fn rows() -> Vec<Value> {
    CASES.lines().skip(2).map(|line| serde_json::from_str(line).expect("JSON")).collect()
}

/// The recording reaches every refusal the operation owns: a count far below
/// this is a recording that stopped reaching them, which reads as a replay
/// that checked.
#[test]
fn the_recording_reaches_every_refusal() {
    let rows = rows();
    let said = |phrase: &str| {
        rows.iter()
            .filter(|row| {
                row["answer"]["content"][0]["text"].as_str().is_some_and(|t| t.contains(phrase))
            })
            .count()
    };
    for phrase in [
        "Nothing to set",
        "nodeId targets a node and edgeId targets an edge",
        "names a node of ONE document",
        "targets the canvas envelope",
        "is a markdown document. Canvas-target facets",
        "is a markdown document. Node-target facets",
        "is a markdown document. Edge-target facets",
        "is a spatial document. Facets are OKF frontmatter",
        "node not found",
        "edge not found",
        "node \"vault\" is locked",
        "edge \"sealed\" is locked",
        "would carry 1025 tags",
        "is not admitted",
        "is one value at a time",
        "is not the current version",
        "its targets are [",
        "which no plugin registered",
        "Unrecognized key: \"extra\"",
        "retired Excalidraw",
        "Document not found",
        "Workspace not found",
    ] {
        assert!(said(phrase) > 0, "no call was refused with: {phrase}");
    }
}

/// ... and every site a write lands on, with what the pages were told of it.
#[test]
fn the_recording_reaches_every_site() {
    let rows = rows();
    let told = |summary: &str| {
        let said = |row: &&Value| {
            row["activity"]
                .as_array()
                .is_some_and(|all| all.iter().any(|t| t["summary"] == summary))
        };
        rows.iter().filter(said).count()
    };
    assert!(told("changed the canvas") >= 4 && told("changed 1") >= 12);
    let touched = |kind: &str| {
        rows.iter().filter(|row| row["activity"][0]["touched"][kind][0].is_string()).count()
    };
    assert!(touched("nodes") >= 8 && touched("edges") >= 3);
    let batches = rows.iter().filter(|row| row["written"].as_array().is_some_and(|w| w.len() > 1));
    assert!(batches.count() >= 3, "a batch of several documents");
}
