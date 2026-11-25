//! `wb_canvas_snapshot` held to what the daemon answered over its boards.
//!
//! `packages/mcp-server/src/server/mcp/oracle/canvas-snapshot.jsonl` is
//! recorded by `canvas-snapshot.oracle.test.ts` beside it: its first row is
//! the record (kept as `W`, with the registry rows that address it, the
//! handles a refusal may name, the ids of its documents by name, and the
//! replica and the instant the recorder scripted the daemon with), the second
//! the stored record before any call, and every row after it one
//! `tools/call`: the result the TypeScript server drew, the activity it told
//! the pages and the documents it reported written. Every answered row is
//! compared whole, its text byte for byte, and the stored record after it is
//! the one before any call, since the tool only reads. A row this crate
//! leaves pending is named in [`PENDING`] and answered as a pending tool,
//! having told nothing, reported nothing and stored nothing.

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
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/canvas-snapshot.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/// The recorded calls this crate leaves pending: a board laid out, whose
/// `layout` field needs the daemon's text measurer and the host's code
/// tokeniser, neither of which a port carries yet; and facets whose keys
/// reach the TypeScript in the order of npm loro's hash map, which a native
/// build cannot know.
const PENDING: &[&str] = &[
    "the board laid out",
    "an empty board laid out",
    "a board past every cap laid out",
    "a facet payload of two keys",
    "a facet bucket of two facets on a line",
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
fn entry(row: &Value) -> WorkspaceEntry {
    WorkspaceEntry {
        workspace_id: text(row, "workspaceId").expect("an id"),
        namespace: text(row, "namespace"),
        segment: text(row, "segment"),
    }
}

#[cfg(test)]
fn fakes(record: &Value) -> Fakes {
    let snapshot = record["snapshot"].as_str().expect("base64 text");
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
        records: MemoryRecordStore::new().holding(W, base64_to_bytes(snapshot).expect("base64")),
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
/// How many pages were told of a call, and how many writes it reported.
fn heard(ports: &Fakes) -> (usize, usize) {
    (ports.notifier.take_activity().len(), ports.observer.take().len())
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
    let expected = doubles(&before["record"]);
    assert_eq!(stored(ports), expected, "the record before any call");
    let (mut answered, mut pending, mut read) = (0, 0, 0);
    for (id, line) in lines.enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        let case = row["case"].as_str().expect("a case");
        assert!(row.get("record").is_none(), "{case}: the daemon stored nothing");
        let message =
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": row["params"] });
        let answer = block_on(server.handle(&message)).expect("an answer");
        if PENDING.contains(&case) {
            assert_eq!(
                answer["error"]["message"],
                json!("Tool wb_canvas_snapshot not found"),
                "{case} is pending"
            );
            pending += 1;
        } else {
            assert_eq!(answer["result"], row["answer"], "{case}");
            answered += 1;
            read += usize::from(row["answer"].get("structuredContent").is_some());
        }
        assert_eq!(heard(ports), (0, 0), "{case}: no page was told and no write reported");
        assert_eq!((&row["activity"], &row["written"]), (&json!([]), &json!([])), "{case}");
        assert_eq!(stored(ports), expected, "{case}: the stored record");
    }
    assert_eq!((answered, pending), (22, 5), "the recording's calls, answered and pending");
    assert_eq!(read, 6, "the calls answered with a board");
}

#[cfg(test)]
fn rows() -> Vec<Value> {
    CASES.lines().skip(2).map(|line| serde_json::from_str(line).expect("JSON")).collect()
}

/// The recording reaches every refusal the operation owns, and every shape a
/// board's elements project to: a count far below this is a recording that
/// stopped reaching them, which reads as a replay that checked.
#[test]
fn the_recording_reaches_every_refusal_and_every_shape() {
    let rows = rows();
    let said = |phrase: &str| {
        rows.iter()
            .filter(|row| {
                row["answer"]["content"][0]["text"].as_str().is_some_and(|t| t.contains(phrase))
            })
            .count()
    };
    for phrase in [
        "projects spatial scenes only",
        "Document not found",
        "Workspace not found",
        "retired Excalidraw",
        "must be a canonical ULID",
        "expected boolean",
        "Unrecognized key: \"extra\"",
        "\"textTruncated\":true",
        "\"locked\":true",
        "\"type\":\"group\"",
        "\"type\":\"file\"",
        "\"type\":\"link\"",
        "\"label\":\"Zone\"",
        "\"tags\":[\"wire\"]",
        "\"bends\":[",
        "\"kind\":\"point\"",
        "\"truncated\":true",
        "\"truncated\":false",
    ] {
        assert!(said(phrase) > 0, "no call was answered with: {phrase}");
    }
    let refused_with_layout = rows
        .iter()
        .filter(|row| row["params"]["arguments"]["layout"] == true)
        .filter(|row| row["answer"]["isError"] == true)
        .count();
    assert_eq!(refused_with_layout, 4, "a layout asked of a call its reads refuse");
}
