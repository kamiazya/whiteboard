//! `wb_version_save` held to what the daemon answered over a document
//! history.
//!
//! `packages/mcp-server/src/server/mcp/oracle/version-save.jsonl` is recorded
//! by `version-save.oracle.test.ts` beside it: its first row is the record
//! (kept as `W`, with the registry rows that address it, the handles a
//! refusal may name, the ids of its documents by name, each document's
//! history as the version store listed it, the keeper's manual ceiling and
//! the mint the recorder scripted the keeper with), and every row after it
//! one `tools/call` and the result the TypeScript server drew, in order: the
//! saves change the history the listings between them read. Every answer is
//! compared whole, its text byte for byte: no difference is tolerated.

use serde_json::{Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_mcp::{Identity, OpsCatalogue, Server};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_ops::Ports;
use whiteboard_port_fakes::{
    FixedCaller, KeyedLock, MemoryRecordStore, MemoryRegistry, MemoryVersionStore, block_on,
};
use whiteboard_ports::{OperatorKind, SavedVersion, VersionOperator, WorkspaceEntry};

const CASES: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/version-save.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

struct Fakes(MemoryRecordStore, MemoryRegistry, FixedCaller, MemoryVersionStore, KeyedLock);

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;
    type Lock = KeyedLock;
    type Clock = whiteboard_port_fakes::FixedClock;
    type Mint = whiteboard_port_fakes::SeqIdMint;
    type Notifier = whiteboard_port_fakes::RecordingNotifier;
    type Observer = whiteboard_port_fakes::RecordingObserver;

    fn records(&self) -> &MemoryRecordStore {
        &self.0
    }

    fn registry(&self) -> &MemoryRegistry {
        &self.1
    }

    fn caller(&self) -> &FixedCaller {
        &self.2
    }

    fn versions(&self) -> &MemoryVersionStore {
        &self.3
    }

    fn clock(&self) -> &whiteboard_port_fakes::FixedClock {
        unreachable!("nothing here writes a record")
    }

    fn mint(&self) -> &whiteboard_port_fakes::SeqIdMint {
        unreachable!("nothing here writes a record")
    }

    fn notifier(&self) -> &whiteboard_port_fakes::RecordingNotifier {
        unreachable!("nothing here writes a record")
    }

    fn observer(&self) -> &whiteboard_port_fakes::RecordingObserver {
        unreachable!("nothing here writes a record")
    }

    fn lock(&self) -> &KeyedLock {
        &self.4
    }
}

#[cfg(test)]
fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key).map(|v| v.as_str().expect("a string").to_owned())
}

#[cfg(test)]
fn entry(row: &Value) -> WorkspaceEntry {
    WorkspaceEntry {
        workspace_id: text(row, "workspaceId").expect("an id"),
        namespace: text(row, "namespace"),
        segment: text(row, "segment"),
    }
}

/// A kept version as the store answers it.
#[cfg(test)]
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

/// Each document's history as the record row keeps it, the keeper's ceiling,
/// and the mint the recorder scripted the keeper with.
#[cfg(test)]
fn keeper(record: &Value) -> MemoryVersionStore {
    let ceiling = record["manualCeiling"].as_u64().expect("a ceiling");
    let mint = &record["mint"];
    let ids = mint["ids"].as_array().expect("ids");
    let store = MemoryVersionStore::new()
        .keeping_at_most(usize::try_from(ceiling).expect("a ceiling"))
        .minting(
            ids.iter().map(|id| id.as_str().expect("an id").to_owned()).collect(),
            mint["at"].as_str().expect("a stamp"),
        );
    record["versions"].as_object().expect("histories").iter().fold(
        store,
        |store, (document_id, rows)| {
            let rows = rows.as_array().expect("rows").iter().map(saved).collect();
            store.holding(W, document_id, rows)
        },
    )
}

#[cfg(test)]
fn server(record: &Value) -> Server<OpsCatalogue<Fakes>> {
    let bytes = base64_to_bytes(record["snapshot"].as_str().expect("a snapshot")).expect("base64");
    let registry = record["registry"]
        .as_array()
        .expect("registry rows")
        .iter()
        .fold(MemoryRegistry::new(), |registry, row| registry.holding(entry(row)));
    let known = record["known"].as_array().expect("known handles");
    let caller = FixedCaller::new()
        .in_namespace(record["callerNamespace"].as_str().expect("a namespace"))
        .knowing(known.iter().map(|h| h.as_str().expect("a handle").to_owned()).collect());
    let records = MemoryRecordStore::new().holding(W, bytes);
    let fakes = Fakes(records, registry, caller, keeper(record), KeyedLock::new());
    let identity =
        Identity { name: "whiteboard".into(), version: "0".into(), instructions: String::new() };
    Server::new(identity, OpsCatalogue::new(fakes))
}

#[test]
fn every_recorded_call_is_answered_as_the_daemon_answered_it() {
    let mut lines = CASES.lines();
    let record: Value = serde_json::from_str(lines.next().expect("a record")).expect("JSON");
    let server = server(&record);
    let (mut replayed, mut saves, mut answered) = (0, 0, 0);
    for (id, line) in lines.enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        let message =
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": row["params"] });
        let answer = block_on(server.handle(&message)).expect("an answer");
        assert_eq!(answer["result"], row["answer"], "{}", row["case"]);
        let save = row["params"]["name"] == "wb_version_save";
        saves += usize::from(save);
        answered += usize::from(save && row["answer"].get("structuredContent").is_some());
        replayed += 1;
    }
    assert_eq!(replayed, 37, "the recording's calls, every one answered");
    assert_eq!((saves, answered), (34, 6), "the saves, and those answered with versions");
}

/// The recording reaches what a save can do: a batch, a repeated document,
/// a refused batch, a full history alone and part way through a batch.
#[test]
fn the_recording_reaches_every_kind_of_save() {
    let rows: Vec<Value> =
        CASES.lines().map(|line| serde_json::from_str(line).expect("JSON")).collect();
    let saves = |text: &str| {
        rows.iter()
            .filter(|row| row["params"]["name"] == "wb_version_save")
            .filter(|row| {
                row["answer"]["content"][0]["text"].as_str().is_some_and(|t| t.contains(text))
            })
            .count()
    };
    assert_eq!(saves("already keeps 200 saved versions"), 2);
    assert_eq!(saves("Document not found"), 2);
    let batches = rows.iter().filter(|row| {
        row["answer"]["structuredContent"]["saved"].as_array().is_some_and(|s| s.len() > 1)
    });
    assert_eq!(batches.count(), 2);
}
