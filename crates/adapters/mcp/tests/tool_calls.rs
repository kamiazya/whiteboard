//! The catalogue over the ops table held to what the TypeScript server
//! answered: `tools/list` for the ported tools, and `tools/call` for each.
//!
//! `fixtures/tool_calls.jsonl` is recorded by
//! `packages/mcp-server/src/server/mcp/tool-contracts.oracle.test.ts`, which
//! drives `createMcpServer` over the workspace records the ops fixture holds
//! (`crates/ops/ops/tests/fixtures/document_reads.jsonl`) and keeps the
//! recording equal to what it answers today. A row with a `snapshot` is a
//! workspace record (`null`: the keeper holds no such workspace); each row
//! after it is one `tools/call` over that record and the result it drew.
//!
//! The comparison is of parsed JSON values, except a text content, which is
//! a string and held byte for byte — the structured output's `JSON.stringify`
//! included. One answer is held to a known difference rather than to the
//! recording; see [`SORTED_KEYS`].

use serde_json::{Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_mcp::{Identity, OpsCatalogue, PENDING_TOOLS, Server, ToolCatalogue};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_ops::Ports;
use whiteboard_port_fakes::{MemoryRecordStore, block_on};

const CASES: &str = include_str!("fixtures/tool_calls.jsonl");
const DOCUMENT_LIST: &str = include_str!("../../../../contracts/tools/wb_document_list.json");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/// The record store alone, which the ported tools read.
struct Fakes(MemoryRecordStore);

impl Ports for Fakes {
    type Records = MemoryRecordStore;

    fn records(&self) -> &MemoryRecordStore {
        &self.0
    }
}

/// A call whose unknown keys the client wrote out of sorted order. The
/// arguments arrive as a `serde_json` map, which keeps its keys sorted, so the
/// SDK's `Unrecognized keys: "b", "a"` (the client's order) is answered with
/// them sorted: the one recorded answer this catalogue does not reproduce.
const SORTED_KEYS: (&str, &str) = ("\"b\", \"a\"", "\"a\", \"b\"");

fn server(store: MemoryRecordStore) -> Server<OpsCatalogue<Fakes>> {
    let identity =
        Identity { name: "whiteboard".into(), version: "0".into(), instructions: String::new() };
    Server::new(identity, OpsCatalogue::new(Fakes(store)))
}

#[cfg(test)]
fn store_of(snapshot: &Value) -> MemoryRecordStore {
    match snapshot.as_str() {
        Some(text) => MemoryRecordStore::new().holding(W, base64_to_bytes(text).expect("base64")),
        None => MemoryRecordStore::new(),
    }
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
    let mut current = server(MemoryRecordStore::new());
    let mut replayed = 0;
    for (id, line) in CASES.lines().enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        if let Some(snapshot) = row.get("snapshot") {
            current = server(store_of(snapshot));
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
    assert_eq!(replayed, 28, "the recording's calls, every one replayed");
}

#[test]
fn the_listing_is_the_contract_of_each_ported_tool() {
    let answer = block_on(
        server(MemoryRecordStore::new())
            .handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })),
    )
    .expect("an answer");
    let contract: Value = serde_json::from_str(DOCUMENT_LIST).expect("the contract parses");
    assert_eq!(answer["result"]["tools"], json!([contract]));
}

#[test]
fn a_pending_tool_is_not_listed_and_not_found() {
    let catalogue = OpsCatalogue::new(Fakes(MemoryRecordStore::new()));
    let listed: Vec<Value> =
        catalogue.tools().into_iter().map(|tool| tool["name"].clone()).collect();
    for name in PENDING_TOOLS {
        assert!(!listed.contains(&json!(name)), "{name} is pending and listed");
        let answer = block_on(server(MemoryRecordStore::new()).handle(&json!({
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
    let catalogue = OpsCatalogue::new(Fakes(MemoryRecordStore::new()));
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
    let catalogue = OpsCatalogue::new(Fakes(MemoryRecordStore::new()));
    let mut named: Vec<Value> =
        catalogue.tools().into_iter().map(|tool| tool["name"].clone()).collect();
    named.extend(PENDING_TOOLS.iter().map(|name| Value::from(*name)));
    let total = named.len();
    named.sort_by_key(ToString::to_string);
    named.dedup();
    assert_eq!(named.len(), total);
}

/// Every tool the ops table names is listed, so an operation that gains a
/// tool cannot go unserved.
#[test]
fn every_tool_the_ops_table_names_is_listed() {
    let catalogue = OpsCatalogue::new(Fakes(MemoryRecordStore::new()));
    let listed: Vec<Value> =
        catalogue.tools().into_iter().map(|tool| tool["name"].clone()).collect();
    let tools: Vec<Value> =
        whiteboard_ops::OPERATIONS.iter().filter_map(|row| row.tool).map(Value::from).collect();
    assert!(!tools.is_empty(), "the table names a tool");
    assert_eq!(listed, tools);
}
