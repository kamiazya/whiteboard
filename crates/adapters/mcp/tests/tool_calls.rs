//! The catalogue over the ops table held to what the TypeScript server
//! answered: `tools/list` for the ported tools, and `tools/call` for each.
//!
//! `packages/mcp-server/src/server/mcp/oracle/tool-calls.jsonl` is recorded by
//! `tool-contracts.oracle.test.ts` beside it, which drives `createMcpServer`
//! and keeps the recording equal to what it answers today. A row with a
//! `snapshot` is a workspace record kept as `W` (`null`: the keeper holds
//! none) with the registry rows that address it, the caller's namespace and
//! the handles a refusal may name, the same records the ops crate's fixture
//! holds; each row after it is one `tools/call` over that record and the
//! result it drew.
//!
//! The comparison is of parsed JSON values, except a text content, which is
//! a string and held byte for byte — the structured output's `JSON.stringify`
//! included. One answer is held to a known difference rather than to the
//! recording; see [`SORTED_KEYS`].

use serde_json::{Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_mcp::{
    Identity, OpsCatalogue, PARTLY_BOUND_TOOLS, PENDING_TOOLS, Server, ToolCatalogue,
};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_ops::Ports;
use whiteboard_port_fakes::{
    FixedCaller, MemoryRecordStore, MemoryRegistry, MemoryVersionStore, block_on,
};
use whiteboard_ports::WorkspaceEntry;

const CASES: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/tool-calls.jsonl");
const READS: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/document-reads.jsonl");
const DOCUMENT_LIST: &str = include_str!("../../../../contracts/tools/wb_document_list.json");
const DOCUMENT_GET: &str = include_str!("../../../../contracts/tools/wb_document_get.json");
const VERSION_LIST: &str = include_str!("../../../../contracts/tools/wb_version_list.json");
const VERSION_SAVE: &str = include_str!("../../../../contracts/tools/wb_version_save.json");
const FACET_LIST: &str = include_str!("../../../../contracts/tools/wb_facet_list.json");
const DOCUMENT_SEARCH: &str = include_str!("../../../../contracts/tools/wb_document_search.json");
const VIEWPORT_SET: &str = include_str!("../../../../contracts/tools/wb_viewport_set.json");
const BODY_EDIT: &str = include_str!("../../../../contracts/tools/wb_body_edit.json");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/// The ports the ported tools read: the record store, the registry, the
/// caller and the version store, which holds no version here.
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

/// No workspace, and a caller in `me` told of none.
fn nothing() -> Fakes {
    Fakes(
        MemoryRecordStore::new(),
        MemoryRegistry::new(),
        FixedCaller::new(),
        MemoryVersionStore::new(),
    )
}

/// A call whose unknown keys the client wrote out of sorted order. The
/// arguments arrive as a `serde_json` map, which keeps its keys sorted, so the
/// SDK's `Unrecognized keys: "b", "a"` (the client's order) is answered with
/// them sorted: the one recorded answer this catalogue does not reproduce.
const SORTED_KEYS: (&str, &str) = ("\"b\", \"a\"", "\"a\", \"b\"");

fn server(fakes: Fakes) -> Server<OpsCatalogue<Fakes>> {
    let identity =
        Identity { name: "whiteboard".into(), version: "0".into(), instructions: String::new() };
    Server::new(identity, OpsCatalogue::new(fakes))
}

/// A registry row as the recording writes it.
#[cfg(test)]
fn entry(row: &Value) -> WorkspaceEntry {
    let text = |key: &str| row.get(key).map(|v| v.as_str().expect("a string").to_owned());
    WorkspaceEntry {
        workspace_id: text("workspaceId").expect("an id"),
        namespace: text("namespace"),
        segment: text("segment"),
    }
}

/// The ports a record row describes.
#[cfg(test)]
fn fakes_of(record: &Value) -> Fakes {
    let records = match record["snapshot"].as_str() {
        Some(text) => MemoryRecordStore::new().holding(W, base64_to_bytes(text).expect("base64")),
        None => MemoryRecordStore::new(),
    };
    let registry = record["registry"]
        .as_array()
        .expect("registry rows")
        .iter()
        .fold(MemoryRegistry::new(), |registry, row| registry.holding(entry(row)));
    let mut caller =
        FixedCaller::new().in_namespace(record["callerNamespace"].as_str().expect("a namespace"));
    if let Some(known) = record["known"].as_array() {
        let known = known.iter().map(|h| h.as_str().expect("a handle").to_owned()).collect();
        caller = caller.knowing(known);
    }
    Fakes(records, registry, caller, MemoryVersionStore::new())
}

#[cfg(test)]
fn expected(row: &Value) -> Value {
    let mut answer = row["answer"].clone();
    if let Some(text) = answer.pointer_mut("/content/0/text") {
        let held = text.as_str().expect("a text").to_owned();
        if held.contains(SORTED_KEYS.0) {
            *text = Value::from(held.replace(SORTED_KEYS.0, SORTED_KEYS.1));
        }
    }
    answer
}

#[test]
fn every_recorded_call_is_answered_as_the_typescript_answered_it() {
    let mut current = server(nothing());
    let mut replayed = 0;
    for (id, line) in CASES.lines().enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        if row.get("snapshot").is_some() {
            current = server(fakes_of(&row));
            continue;
        }
        let message =
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": row["params"] });
        let answer = block_on(current.handle(&message)).expect("an answer");
        assert_eq!(answer["result"], expected(&row), "{}: {}", row["case"], row["params"]);
        if let Some(Value::String(text)) = answer.pointer("/result/content/0/text") {
            let structured = answer.pointer("/result/structuredContent");
            if let Some(structured) = structured {
                assert_eq!(&serde_json::from_str::<Value>(text).expect("JSON text"), structured);
            }
        }
        replayed += 1;
    }
    assert_eq!(replayed, 44, "the recording's calls, every one replayed");
}

/// The record rows, in order.
#[cfg(test)]
fn records(rows: &str) -> Vec<Value> {
    rows.lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a JSON row"))
        .filter(|row| row.get("snapshot").is_some())
        .collect()
}

#[test]
fn the_recorded_calls_run_over_the_records_the_ops_fixture_holds() {
    let records = records(CASES);
    assert_eq!(records.len(), 7, "the recording's records");
    assert_eq!(records, self::records(READS));
}

#[test]
fn the_listing_is_the_contract_of_each_ported_tool() {
    let answer = block_on(
        server(nothing()).handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })),
    )
    .expect("an answer");
    let contract = |text: &str| serde_json::from_str::<Value>(text).expect("the contract parses");
    let listed = [
        contract(DOCUMENT_LIST),
        contract(DOCUMENT_GET),
        contract(VERSION_LIST),
        contract(VERSION_SAVE),
        contract(FACET_LIST),
        contract(DOCUMENT_SEARCH),
        contract(VIEWPORT_SET),
        contract(BODY_EDIT),
    ];
    assert_eq!(answer["result"]["tools"], json!(listed));
}

/// Every listed tool is dispatched to its binding: called with no arguments,
/// each answers its own input refusal, never `not found`.
#[test]
fn every_listed_tool_is_called_through_its_binding() {
    let catalogue = OpsCatalogue::new(nothing());
    for tool in catalogue.tools() {
        let name = tool["name"].as_str().expect("a name");
        let answer = block_on(server(nothing()).handle(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": name, "arguments": { "unknown": true } } })))
        .expect("an answer");
        let text = answer["result"]["content"][0]["text"].as_str().unwrap_or_default();
        let refused = format!("Input validation error: Invalid arguments for tool {name}: ");
        assert!(text.starts_with(&refused), "{name}: {answer}");
    }
}

/// Zod 4 judges the bounds of any value with a numeric `length`, so an object
/// given for a string is refused for its type and then its length.
#[test]
fn an_object_given_for_a_string_is_judged_for_its_length_too() {
    let refusal = |name: &str, arguments: Value| {
        let answer = block_on(server(nothing()).handle(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": name, "arguments": arguments } })))
        .expect("an answer");
        answer["result"]["content"][0]["text"].as_str().unwrap_or_default().to_owned()
    };
    let wrong = "Invalid input: expected string, received object";
    let label = refusal("wb_version_save", json!({ "label": { "length": 0 } }));
    assert!(
        label.contains(&format!("label: {wrong}, label: Too small: expected unknown to be >=1")),
        "{label}"
    );
    let query = refusal("wb_document_search", json!({ "query": { "length": 2000 } }));
    assert!(
        query.contains(&format!(
            "query: {wrong}, query: a search query is longer than the 1024-character limit"
        )),
        "{query}"
    );
    let version = refusal("wb_version_restore", json!({ "versionId": { "length": 2000 } }));
    assert!(
        version.contains(&format!(
            "versionId: {wrong}, versionId: a version id is longer than the 256-character limit for one id"
        )),
        "{version}"
    );
}

#[test]
fn a_pending_tool_is_not_listed_and_not_found() {
    let catalogue = OpsCatalogue::new(nothing());
    let listed: Vec<Value> =
        catalogue.tools().into_iter().map(|tool| tool["name"].clone()).collect();
    for name in PENDING_TOOLS {
        assert!(!listed.contains(&json!(name)), "{name} is pending and listed");
        if PARTLY_BOUND_TOOLS.contains(name) {
            continue;
        }
        let answer = block_on(server(nothing()).handle(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": name, "arguments": {} } })))
        .expect("an answer");
        assert_eq!(answer["error"]["message"], json!(format!("Tool {name} not found")));
    }
}

/// Every contract file is a tool this catalogue lists or names as pending,
/// never both; the TypeScript side holds the files to what it registers.
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn the_contracts_are_the_listed_tools_and_the_pending_ones() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../contracts/tools");
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .expect("the contracts directory")
        .map(|entry| entry.expect("an entry").file_name().into_string().expect("a name"))
        .collect();
    files.sort();
    let catalogue = OpsCatalogue::new(nothing());
    let mut named: Vec<String> = catalogue
        .tools()
        .iter()
        .map(|tool| tool["name"].as_str().expect("a name").to_owned())
        .chain(PENDING_TOOLS.iter().map(|name| (*name).to_owned()))
        .map(|name| format!("{name}.json"))
        .collect();
    named.sort();
    assert_eq!(files, named);
}

/// The wasm32 half of the test above, which reads a directory: no tool is
/// both listed and pending, and none is named twice.
#[cfg(target_arch = "wasm32")]
#[test]
fn the_listed_and_pending_tools_are_named_once() {
    let catalogue = OpsCatalogue::new(nothing());
    let mut named: Vec<Value> =
        catalogue.tools().into_iter().map(|tool| tool["name"].clone()).collect();
    named.extend(PENDING_TOOLS.iter().map(|name| Value::from(*name)));
    let total = named.len();
    named.sort_by_key(ToString::to_string);
    named.dedup();
    assert_eq!(named.len(), total);
}

/// Every tool the ops table names is listed or partly bound, so an operation
/// that gains a tool cannot go unserved; a partly bound tool is a pending one.
#[test]
fn every_tool_the_ops_table_names_is_listed_or_partly_bound() {
    let catalogue = OpsCatalogue::new(nothing());
    let listed: Vec<Value> =
        catalogue.tools().into_iter().map(|tool| tool["name"].clone()).collect();
    for name in PARTLY_BOUND_TOOLS {
        assert!(PENDING_TOOLS.contains(name), "{name} is partly bound and not pending");
    }
    let tools: Vec<Value> = whiteboard_ops::OPERATIONS
        .iter()
        .filter_map(|row| row.tool)
        .filter(|tool| !PARTLY_BOUND_TOOLS.contains(tool))
        .map(Value::from)
        .collect();
    let bound = whiteboard_ops::OPERATIONS.iter().filter_map(|row| row.tool);
    assert_eq!(
        bound.filter(|tool| PARTLY_BOUND_TOOLS.contains(tool)).count(),
        PARTLY_BOUND_TOOLS.len()
    );
    assert!(!tools.is_empty(), "the table names a tool");
    assert_eq!(listed, tools);
}
