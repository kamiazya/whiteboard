//! The dispatcher held to what the TypeScript MCP server answered.
//!
//! `fixtures/protocol.jsonl` was recorded by driving `createMcpServer` — the
//! `@modelcontextprotocol/server` `McpServer` with the whiteboard's
//! capabilities, prompt, resource and tools registered — over the SDK's
//! in-memory transport, one fresh server per case. Its first row is `meta`:
//! the server's identity, the capabilities it declared and the SDK's
//! supported protocol versions. Each later row is one case: the messages sent
//! in order, each beside the one answer it drew (`null`: none).
//!
//! The comparison is of parsed JSON values, so object key order is ignored:
//! RFC 8259 gives member order no meaning and the SDK's client reads members
//! by name. What a transport writes byte for byte is the transport's. Three
//! more things are normalised, each recorded rather than reconstructed:
//!
//! - a `tools/list` result's `tools` were recorded as `"$catalogue"`, since the
//!   tool table is the ops layer's, not the protocol's; this test's catalogue answers in its place;
//! - an `initialize` result's `instructions` were recorded as
//!   `"$instructions"` (the text is in `meta`, handed to the server as its
//!   identity, and the answer is held to carry it verbatim);
//! - the capabilities that announce what later slices serve (`prompts`,
//!   `resources`, the MCP Apps extension) are removed from the recorded
//!   `initialize` result, and the cases marked `later` (those methods) are
//!   held to be exactly those methods, answered `Method not found` here.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_api_contracts::Refusal;
use whiteboard_mcp::{Identity, SUPPORTED_PROTOCOL_VERSIONS, Server, ToolCatalogue, ToolError};
use whiteboard_port_fakes::block_on;

const CASES: &str = include_str!("fixtures/protocol.jsonl");

/// The capabilities `initialize` declares for what later slices serve.
const LATER_CAPABILITIES: [&str; 3] = ["prompts", "resources", "extensions"];

/// The methods the TypeScript server registers that later slices serve.
const LATER_METHODS: [&str; 5] =
    ["prompts/list", "prompts/get", "resources/list", "resources/templates/list", "resources/read"];

/// A catalogue of one tool, `wb_document_list`, which refuses every
/// workspace as the TypeScript refused the one the recording names.
struct Catalogue;

impl ToolCatalogue for Catalogue {
    fn tools(&self) -> Vec<Value> {
        vec![json!({ "name": "wb_document_list" })]
    }

    async fn call(
        &self,
        name: &str,
        arguments: Option<&Map<String, Value>>,
    ) -> Result<Value, ToolError> {
        if name != "wb_document_list" {
            return Err(ToolError::NotFound);
        }
        let workspace = arguments.and_then(|a| a.get("workspaceId")).and_then(Value::as_str);
        Err(ToolError::Refused(Refusal::WorkspaceNotFoundForCallerRead {
            workspace_id: workspace.unwrap_or_default().to_owned(),
        }))
    }
}

#[cfg(test)]
fn rows() -> Vec<Value> {
    CASES.lines().map(|line| serde_json::from_str(line).expect("a JSON row")).collect()
}

#[cfg(test)]
fn meta() -> Value {
    rows()[0]["meta"].clone()
}

#[cfg(test)]
fn identity(meta: &Value) -> Identity {
    Identity {
        name: meta["serverInfo"]["name"].as_str().expect("a name").to_owned(),
        version: meta["serverInfo"]["version"].as_str().expect("a version").to_owned(),
        instructions: meta["instructions"].as_str().expect("instructions").to_owned(),
    }
}

/// The Rust answer with what the recording replaced by a marker replaced the
/// same way, after checking the replaced text.
#[cfg(test)]
fn normalised_answer(mut answer: Value, meta: &Value) -> Value {
    if let Some(result) = answer.get_mut("result").and_then(Value::as_object_mut) {
        if result.get("tools").is_some_and(Value::is_array) {
            assert_eq!(result["tools"], json!([{ "name": "wb_document_list" }]));
            result.insert("tools".into(), json!("$catalogue"));
        }
        if let Some(instructions) = result.get("instructions") {
            assert_eq!(instructions, &meta["instructions"]);
            result.insert("instructions".into(), json!("$instructions"));
        }
    }
    answer
}

/// The recorded answer without the capabilities later slices declare.
#[cfg(test)]
fn expected_answer(mut recorded: Value) -> Value {
    if let Some(capabilities) =
        recorded.pointer_mut("/result/capabilities").and_then(Value::as_object_mut)
    {
        for key in LATER_CAPABILITIES {
            assert!(capabilities.remove(key).is_some(), "the recording declares {key}");
        }
    }
    recorded
}

#[cfg(test)]
fn replay(case: &Value, meta: &Value) -> Vec<(Value, Value, Value)> {
    let server = Server::new(identity(meta), Catalogue);
    let exchange = case["exchange"].as_array().expect("an exchange");
    exchange
        .iter()
        .map(|pair| {
            let answer = block_on(server.handle(&pair[0]));
            let got = answer.map_or(Value::Null, |answer| normalised_answer(answer, meta));
            (pair[0].clone(), got, expected_answer(pair[1].clone()))
        })
        .collect()
}

#[test]
fn every_recorded_case_is_answered_as_the_typescript_answered_it() {
    let rows = rows();
    let meta = &rows[0]["meta"];
    let mut replayed = 0;
    for case in rows.iter().skip(1).filter(|case| case["later"].is_null()) {
        for (sent, got, expected) in replay(case, meta) {
            assert_eq!(got, expected, "{}: answering {sent}", case["case"]);
            replayed += 1;
        }
    }
    assert_eq!(replayed, 776, "the messages replayed");
}

#[test]
fn the_cases_left_to_later_slices_are_exactly_their_methods() {
    let rows = rows();
    let meta = &rows[0]["meta"];
    let mut methods = BTreeSet::new();
    for case in rows.iter().skip(1).filter(|case| case["later"] == json!(true)) {
        let (sent, got, _) = replay(case, meta).pop().expect("a message");
        methods.insert(sent["method"].as_str().expect("a method").to_owned());
        assert_eq!(got["error"], json!({ "code": -32601, "message": "Method not found" }));
    }
    assert_eq!(methods, LATER_METHODS.iter().map(|m| (*m).to_owned()).collect());
}

#[test]
fn the_supported_versions_are_the_sdks() {
    assert_eq!(meta()["supportedProtocolVersions"], json!(SUPPORTED_PROTOCOL_VERSIONS));
}

#[test]
fn the_declared_capabilities_are_the_typescripts_but_for_the_later_slices() {
    let meta = meta();
    let server = Server::new(identity(&meta), Catalogue);
    let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {},
        "clientInfo": { "name": "t", "version": "1" } } });
    let answer = block_on(server.handle(&message)).expect("an answer");
    let mut recorded = meta["capabilities"].as_object().expect("capabilities").clone();
    for key in LATER_CAPABILITIES {
        recorded.remove(key);
    }
    assert_eq!(answer["result"]["capabilities"], Value::Object(recorded));
}
