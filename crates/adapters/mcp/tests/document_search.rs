//! `wb_document_search` held to what the daemon answered (lexically: no
//! embedder is configured), over a workspace of notes in named and unnamed
//! folders, a board of every node kind with labelled and unlabelled edges,
//! tags on notes, the board, nodes and edges, emoji shown and written as
//! shortcodes, Japanese, and links an excerpt labels.
//!
//! `packages/mcp-server/src/server/mcp/oracle/document-search.jsonl` is
//! recorded by `document-search.oracle.test.ts` beside it: its first row is
//! the one workspace's record (`snapshot`), the registry rows that address it,
//! the caller's namespace and the handles a refusal may name, and every row
//! after it one `tools/call` and the result the TypeScript server drew, its
//! structured half held as `structured: true` and parsed back from its text
//! here. Every answer is held byte for byte, and none is declared a
//! difference.

use serde_json::{Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_mcp::{Identity, OpsCatalogue, Server};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_ops::Ports;
use whiteboard_port_fakes::{
    FixedCaller, MemoryRecordStore, MemoryRegistry, MemoryVersionStore, block_on,
};
use whiteboard_ports::WorkspaceEntry;

const CASES: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/document-search.jsonl");

struct Fakes(MemoryRecordStore, MemoryRegistry, FixedCaller);

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;
    type Lock = whiteboard_port_fakes::KeyedLock;
    type Notifier = whiteboard_port_fakes::RecordingNotifier;

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
        unreachable!("a search lists no version")
    }

    fn lock(&self) -> &whiteboard_port_fakes::KeyedLock {
        unreachable!("a read takes no lock")
    }

    fn notifier(&self) -> &whiteboard_port_fakes::RecordingNotifier {
        unreachable!("this call tells no page")
    }
}

#[cfg(test)]
fn server(record: &Value) -> Server<OpsCatalogue<Fakes>> {
    let text = |row: &Value, key: &str| row.get(key).map(|v| v.as_str().expect("text").to_owned());
    let rows = record["registry"].as_array().expect("registry rows");
    let registry = rows.iter().fold(MemoryRegistry::new(), |registry, row| {
        registry.holding(WorkspaceEntry {
            workspace_id: text(row, "workspaceId").expect("an id"),
            namespace: text(row, "namespace"),
            segment: text(row, "segment"),
        })
    });
    let workspace = text(&rows[0], "workspaceId").expect("the workspace");
    let bytes = base64_to_bytes(record["snapshot"].as_str().expect("a snapshot")).expect("base64");
    let known = record["known"].as_array().into_iter().flatten();
    let caller = FixedCaller::new()
        .in_namespace(record["callerNamespace"].as_str().expect("a namespace"))
        .knowing(known.map(|h| h.as_str().expect("a handle").to_owned()).collect());
    let records = MemoryRecordStore::new().holding(&workspace, bytes);
    let identity =
        Identity { name: "whiteboard".into(), version: "0".into(), instructions: String::new() };
    Server::new(identity, OpsCatalogue::new(Fakes(records, registry, caller)))
}

#[cfg(test)]
fn first_text(result: &Value) -> String {
    result["content"][0]["text"].as_str().expect("a text").to_owned()
}

#[test]
fn every_recorded_call_is_answered_as_the_daemon_answered_it() {
    let mut lines = CASES.lines();
    let record: Value = serde_json::from_str(lines.next().expect("a record")).expect("JSON");
    let server = server(&record);
    let (mut replayed, mut answered, mut ranked, mut filtered) = (0, 0, 0, 0);
    for (id, line) in lines.enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        let message =
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": row["params"] });
        let answer = block_on(server.handle(&message)).expect("an answer");
        let case = row["case"].as_str().expect("a case");
        let held = &row["answer"];
        replayed += 1;
        if held.get("structured") != Some(&Value::Bool(true)) {
            assert_eq!(answer["result"], *held, "{case}");
            continue;
        }
        let result = &answer["result"];
        let said = first_text(result);
        let parsed: Value = serde_json::from_str(&said).expect("JSON text");
        assert_eq!(result["structuredContent"], parsed, "{case}: the text spells the structure");
        assert_eq!(said, first_text(held), "{case}");
        let results = parsed["results"].as_array().expect("results");
        answered += usize::from(!results.is_empty());
        ranked += usize::from(results.iter().any(|hit| hit.get("lexicalRank").is_some()));
        filtered += usize::from(results.iter().any(|hit| hit.get("lexicalRank").is_none()));
    }
    assert_eq!(replayed, 87, "the recording's calls, every one answered");
    assert_eq!(answered, 41, "the calls that found something");
    assert_eq!(ranked, 29, "the calls words ranked");
    assert_eq!(filtered, 12, "the calls a filter answered alone");
}

/// A workspace holding documents whose content this crate does not read yet
/// (`wb_document_get`'s recording holds retired stored shapes and documents
/// with no kind) is answered as pending, never as a search that skipped
/// them; what the TypeScript answers there is not recorded.
#[test]
fn a_workspace_holding_a_retired_shape_is_pending() {
    const CONTENT: &str =
        include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/document-get.jsonl");
    let record: Value =
        serde_json::from_str(CONTENT.lines().next().expect("a record")).expect("JSON");
    let workspace = record["registry"][0]["workspaceId"].clone();
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": "wb_document_search",
            "arguments": { "workspaceId": workspace, "query": "a" } } });
    let answer = block_on(server(&record).handle(&call)).expect("an answer");
    assert_eq!(answer["error"]["message"], json!("Tool wb_document_search not found"));
}
