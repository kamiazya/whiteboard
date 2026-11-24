//! `wb_version_restore` held to what the daemon answered over a document
//! history.
//!
//! `packages/mcp-server/src/server/mcp/oracle/version-restore.jsonl` is
//! recorded by `version-restore.oracle.test.ts` beside it: its first row is
//! the record (kept as `W`, with the registry rows that address it, the
//! handles a refusal may name, the ids of its documents by name, each
//! document's history as the version store listed it, each version's past
//! document, the restore-point ceiling, and the replica and the mint the
//! recorder scripted the daemon with), the second the stored record before
//! any call, and every row after it one `tools/call`: the result the
//! TypeScript server drew, the restore progress it told the pages, the
//! documents it reported written, and the stored record after it when the
//! call moved it (its value, version vector and frontiers). Every answered
//! row is compared whole, its text byte for byte, and so is what it told and
//! what it stored; a row this crate leaves pending is named in [`PENDING`]
//! and answered as a pending tool. Pending rows come last in the recording,
//! since the daemon writes for them and nothing after them may read it.

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
use whiteboard_ports::{
    OperatorKind, RestorePhase, SavedVersion, VersionOperator, WorkspaceEntry, WorkspaceRecordStore,
};

const CASES: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/version-restore.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/// The recorded calls this crate leaves pending: restores into another path
/// and subtree rollbacks nothing refuses, writes changing more than one of a
/// document's roots (whose order is an owner decision still open), and
/// version ids the daemon's keeper refuses in words no contract holds.
const PENDING: &[&str] = &[
    "a version id no keeper spells",
    "a version id past the keeper bound",
    "a version id of 256 characters",
    "a version id of 128 characters and 256 units",
    "nodes and an edge back at once",
    "a body and a facet back at once",
    "into a path nothing holds",
    "onto a document of the same kind",
    "a subtree",
    "a subtree naming its own path",
    "into a path of 1024 characters",
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
/// A kept version as the store answers it.
fn saved(row: &Value) -> SavedVersion {
    let operator = row.get("operator").map(|operator| VersionOperator {
        kind: match operator["kind"].as_str().expect("a kind") {
            "ai" => OperatorKind::Ai,
            "human" => OperatorKind::Human,
            _ => OperatorKind::System,
        },
        display_name: text(operator, "displayName"),
    });
    SavedVersion {
        id: text(row, "id").expect("an id"),
        created_at: text(row, "createdAt").expect("a stamp"),
        label: text(row, "label"),
        auto: row["auto"].as_bool().expect("a flag"),
        operator,
        restored_from: text(row, "restoredFrom"),
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
/// Each document's history, each version's past document, and the mint.
/// Every version the daemon saves carries the whole workspace, which a
/// subtree rollback asks for; the record stands in for it, since a rollback
/// that reaches it is pending.
fn keeper(record: &Value) -> MemoryVersionStore {
    let ceiling = record["restorePointCeiling"].as_u64().expect("a ceiling");
    let mint = &record["mint"];
    let ids = mint["ids"].as_array().expect("ids");
    let snapshot = bytes(&record["snapshot"]);
    let store = MemoryVersionStore::new()
        .keeping_restore_points_at_most(usize::try_from(ceiling).expect("a ceiling"))
        .minting(
            ids.iter().map(|id| id.as_str().expect("an id").to_owned()).collect(),
            mint["at"].as_str().expect("a stamp"),
        );
    let store = record["versions"].as_object().expect("histories").iter().fold(
        store,
        |store, (document_id, rows)| {
            let rows = rows.as_array().expect("rows").iter().map(saved).collect();
            store.holding(W, document_id, rows)
        },
    );
    record["checkouts"].as_object().expect("checkouts").iter().fold(store, |store, (id, past)| {
        store.checking_out(W, id, bytes(past)).holding_workspace_at(W, id, snapshot.clone())
    })
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
        versions: keeper(record),
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
fn progress(ports: &Fakes) -> Value {
    let told = ports.notifier.take().into_iter().map(|event| {
        let mut row = json!({
            "workspaceId": event.workspace_id,
            "path": event.path,
            "phase": match event.phase {
                RestorePhase::Started => "started",
                RestorePhase::Complete => "complete",
            },
        });
        if let Some(label) = event.label {
            row["label"] = Value::from(label);
        }
        row
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
    let (mut answered, mut pending, mut restored) = (0, 0, 0);
    for (id, line) in lines.enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        let case = row["case"].as_str().expect("a case");
        let message =
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": row["params"] });
        let answer = block_on(server.handle(&message)).expect("an answer");
        if PENDING.contains(&case) {
            assert_eq!(
                answer["error"]["message"],
                json!("Tool wb_version_restore not found"),
                "{case} is pending"
            );
            let _ = (ports.notifier.take(), ports.observer.take());
            pending += 1;
            continue;
        }
        assert_eq!(answer["result"], row["answer"], "{case}");
        assert_eq!(progress(ports), row["progress"], "{case}: what the pages were told");
        assert_eq!(written(ports), row["written"], "{case}: what was reported written");
        if let Some(moved) = row.get("record") {
            expected = doubles(moved);
        }
        assert_eq!(stored(ports), expected, "{case}: the stored record");
        answered += 1;
        let mode = &row["answer"]["structuredContent"]["mode"];
        restored += usize::from(mode == "in-place");
    }
    assert_eq!((answered, pending), (52, 11), "the recording's calls, answered and pending");
    assert_eq!(restored, 9, "the calls restored in place");
}
