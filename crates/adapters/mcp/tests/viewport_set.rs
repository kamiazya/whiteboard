//! `wb_viewport_set` held to what the daemon answered with a page watching.
//!
//! `packages/mcp-server/src/server/mcp/oracle/viewport-set.jsonl` is recorded
//! by `viewport-set.oracle.test.ts` beside it: its first row is the record
//! (kept as `W`, with the registry rows that address it, the handles a
//! refusal may name, the ids of its documents by path, and the pages open on
//! them, ready or not), and every row after it one `tools/call`, the result
//! the TypeScript server drew, and the viewport requests a ready page was
//! sent. Every answer is compared whole, its text byte for byte, and every
//! request a page was sent is the one the notifier was handed: no difference
//! is tolerated.

use std::sync::Arc;

use serde_json::{Map, Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_mcp::{Identity, OpsCatalogue, Server};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_ops::Ports;
use whiteboard_port_fakes::{
    FixedCaller, KeyedLock, MemoryRecordStore, MemoryRegistry, MemoryVersionStore,
    RecordingNotifier, block_on,
};
use whiteboard_ports::{ViewportMode, ViewportRequest, WorkspaceEntry};

const CASES: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/viewport-set.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

struct Fakes(MemoryRecordStore, MemoryRegistry, FixedCaller, Arc<RecordingNotifier>);

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;
    type Lock = KeyedLock;
    type Notifier = RecordingNotifier;

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
        unreachable!("a viewport request reads no version")
    }

    fn lock(&self) -> &KeyedLock {
        unreachable!("a viewport request takes no lock")
    }

    fn notifier(&self) -> &RecordingNotifier {
        &self.3
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

/// The pages the record row opens: a ready one is told, one that has not
/// signalled `client_ready` is not.
#[cfg(test)]
fn pages(record: &Value) -> RecordingNotifier {
    let ids = &record["ids"];
    record["watching"].as_array().expect("pages").iter().filter(|page| page["ready"] == true).fold(
        RecordingNotifier::new(),
        |pages, page| {
            let path = page["path"].as_str().expect("a path");
            pages.watching(W, ids[path].as_str().expect("an id"))
        },
    )
}

#[cfg(test)]
fn server(record: &Value, pages: Arc<RecordingNotifier>) -> Server<OpsCatalogue<Fakes>> {
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
    let fakes = Fakes(records, registry, caller, pages);
    let identity =
        Identity { name: "whiteboard".into(), version: "0".into(), instructions: String::new() };
    Server::new(identity, OpsCatalogue::new(fakes))
}

/// A number as a double, so `2` and `2.0` read alike; anything else as is.
#[cfg(test)]
fn as_doubles(value: &Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64().expect("a double")),
        Value::Array(items) => Value::Array(items.iter().map(as_doubles).collect()),
        Value::Object(members) => {
            Value::Object(members.iter().map(|(k, v)| (k.clone(), as_doubles(v))).collect())
        }
        other => other.clone(),
    }
}

/// The frame a page is sent for `request`, without the id the keeper mints:
/// the type, then each field the caller sent.
#[cfg(test)]
fn frame(request: &ViewportRequest) -> Value {
    let mut frame = Map::new();
    frame.insert("type".into(), json!("viewport_request"));
    if let Some(mode) = request.mode {
        let mode = match mode {
            ViewportMode::Fit => "fit",
            ViewportMode::Move => "move",
        };
        frame.insert("mode".into(), json!(mode));
    }
    if let Some(ids) = &request.element_ids {
        frame.insert("elementIds".into(), json!(ids));
    }
    for (key, number) in
        [("scrollX", request.scroll_x), ("scrollY", request.scroll_y), ("zoom", request.zoom)]
    {
        if let Some(number) = number {
            frame.insert(key.into(), json!(number));
        }
    }
    Value::Object(frame)
}

#[test]
fn every_recorded_call_is_answered_as_the_daemon_answered_it() {
    let mut lines = CASES.lines();
    let record: Value = serde_json::from_str(lines.next().expect("a record")).expect("JSON");
    let pages = Arc::new(pages(&record));
    let server = server(&record, Arc::clone(&pages));
    let notifier = || pages.requests();
    let (mut replayed, mut answered, mut told) = (0, 0, 0);
    for (id, line) in lines.enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        let before = notifier().len();
        let message =
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": row["params"] });
        let answer = block_on(server.handle(&message)).expect("an answer");
        assert_eq!(answer["result"], row["answer"], "{}", row["case"]);
        let handed: Vec<Value> = notifier()[before..].iter().map(frame).collect();
        let answers = row["answer"].get("structuredContent").is_some();
        assert_eq!(handed.len(), usize::from(answers), "{}", row["case"]);
        let sent: Vec<Value> =
            row["told"].as_array().expect("told").iter().map(as_doubles).collect();
        if !sent.is_empty() {
            assert_eq!(handed, sent, "{}", row["case"]);
        }
        answered += usize::from(answers);
        told += sent.len();
        replayed += 1;
    }
    assert_eq!(replayed, 73, "the recording's calls, every one answered");
    assert_eq!((answered, told), (20, 17), "the calls answered, and those a page was told of");
}
