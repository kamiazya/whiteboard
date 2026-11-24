//! `wb_version_list` held to what the daemon answered over a document
//! history.
//!
//! `packages/mcp-server/src/server/mcp/oracle/version-list.jsonl` is recorded
//! by `version-list.oracle.test.ts` beside it: its first row is the record
//! (kept as `W`, with the registry rows that address it, the handles a
//! refusal may name, the ids of its documents by name and each document's
//! history as the version store listed it), and every row after it one
//! `tools/call` and the result the TypeScript server drew. Every answer is
//! compared whole, its text byte for byte: no difference is tolerated.

use serde_json::{Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_mcp::{Identity, OpsCatalogue, Server};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_ops::Ports;
use whiteboard_port_fakes::{
    FixedCaller, MemoryRecordStore, MemoryRegistry, MemoryVersionStore, block_on,
};
use whiteboard_ports::{OperatorKind, SavedVersion, VersionOperator, WorkspaceEntry};

const CASES: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/version-list.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

struct Fakes(MemoryRecordStore, MemoryRegistry, FixedCaller, MemoryVersionStore);

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;
    type Lock = whiteboard_port_fakes::KeyedLock;
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

    fn observer(&self) -> &whiteboard_port_fakes::RecordingObserver {
        unreachable!("nothing here writes a record")
    }

    fn lock(&self) -> &whiteboard_port_fakes::KeyedLock {
        unreachable!("a read takes no lock")
    }

    fn notifier(&self) -> &whiteboard_port_fakes::RecordingNotifier {
        unreachable!("this call tells no page")
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

/// Each document's history as the record row keeps it.
#[cfg(test)]
fn histories(record: &Value) -> MemoryVersionStore {
    record["versions"].as_object().expect("histories").iter().fold(
        MemoryVersionStore::new(),
        |store, (document_id, rows)| {
            let rows = rows.as_array().expect("rows").iter().map(saved).collect();
            store.holding(W, document_id, rows)
        },
    )
}

#[cfg(test)]
fn server(record: &Value, versions: MemoryVersionStore) -> Server<OpsCatalogue<Fakes>> {
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
    let fakes = Fakes(MemoryRecordStore::new().holding(W, bytes), registry, caller, versions);
    let identity =
        Identity { name: "whiteboard".into(), version: "0".into(), instructions: String::new() };
    Server::new(identity, OpsCatalogue::new(fakes))
}

#[test]
fn every_recorded_call_is_answered_as_the_daemon_answered_it() {
    let mut lines = CASES.lines();
    let record: Value = serde_json::from_str(lines.next().expect("a record")).expect("JSON");
    let server = server(&record, histories(&record));
    let mut replayed = 0;
    let mut listed = 0;
    for (id, line) in lines.enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        let message =
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": row["params"] });
        let answer = block_on(server.handle(&message)).expect("an answer");
        assert_eq!(answer["result"], row["answer"], "{}", row["case"]);
        listed += usize::from(row["answer"].get("structuredContent").is_some());
        replayed += 1;
    }
    assert_eq!(replayed, 21, "the recording's calls, every one answered");
    assert_eq!(listed, 5, "the calls answered with a listing");
}

/// The recording reaches every shape a row takes: a label, an operator of
/// each kind with and without a name, a restore point, and the store's
/// order kept where two saves share a millisecond.
#[test]
fn the_recorded_history_reaches_every_shape_of_row() {
    let record: Value =
        serde_json::from_str(CASES.lines().next().expect("a record")).expect("JSON");
    let rows: Vec<SavedVersion> = record["versions"]
        .as_object()
        .expect("histories")
        .values()
        .flat_map(|rows| rows.as_array().expect("rows").iter().map(saved))
        .collect();
    let kinds =
        |kind| rows.iter().filter(move |row| row.operator.as_ref().is_some_and(|o| o.kind == kind));
    assert!(
        kinds(OperatorKind::Ai)
            .any(|row| row.operator.as_ref().is_some_and(|o| o.display_name.is_some()))
    );
    assert!(
        kinds(OperatorKind::Ai)
            .any(|row| row.operator.as_ref().is_some_and(|o| o.display_name.is_none()))
    );
    assert!(kinds(OperatorKind::Human).count() > 0);
    assert!(kinds(OperatorKind::System).count() > 0);
    assert!(rows.iter().any(|row| row.operator.is_none()));
    assert!(rows.iter().any(|row| row.restored_from.is_some()));
    assert!(
        rows.iter().any(|row| row.label.is_some()) && rows.iter().any(|row| row.label.is_none())
    );
    assert!(rows.iter().any(|row| row.auto) && rows.iter().any(|row| !row.auto));
    assert!(rows.windows(2).any(|pair| pair[0].created_at == pair[1].created_at));
}

/// A store that cannot answer is refused with its own failure, after the
/// document was found: the listing is never answered as empty.
#[test]
fn a_store_that_cannot_list_is_answered_with_its_failure() {
    let record: Value =
        serde_json::from_str(CASES.lines().next().expect("a record")).expect("JSON");
    let busy = MemoryVersionStore::failing(whiteboard_ports::PortError::DatabaseBusy);
    let server = server(&record, busy);
    let call = |document_id: &str| {
        let params = json!({ "name": "wb_version_list",
            "arguments": { "workspaceId": W, "documentId": document_id } });
        let message =
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params });
        block_on(server.handle(&message)).expect("an answer")["result"].clone()
    };
    let plan = record["ids"]["plan"].as_str().expect("an id");
    assert_eq!(
        call(plan),
        json!({ "content": [{ "type": "text", "text": "The database is busy; retry shortly." }],
            "isError": true })
    );
    let nothing = call("01BX5ZZKBKACTAV9WEVGEMMVRZ");
    assert_eq!(
        nothing["content"][0]["text"],
        json!(format!("Document not found: 01BX5ZZKBKACTAV9WEVGEMMVRZ in workspace {W}"))
    );
}
