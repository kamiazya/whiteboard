//! `wb_facet_list` held to what the daemon answered over the deployment's
//! registry.
//!
//! `packages/mcp-server/src/server/mcp/oracle/facet-list.jsonl` is recorded
//! by `facet-list.oracle.test.ts` beside it: its first row is the one
//! workspace's registry rows, the caller's namespace and the handles a
//! refusal may name, and every row after it one `tools/call` and the result
//! the TypeScript server drew, its structured half held as `structured:
//! true` and parsed back from its text here.
//!
//! A facet's payload schema is served as `z.toJSONSchema` writes the
//! generated Zod (owner decision q136), so every answer is held byte for byte.
//!
//! One difference is declared rather than reproduced, and counted:
//!
//! - [`PENDING`]: a call naming a workspace that resolves is answered as a
//!   pending tool: the workspace's own stencils, tags in use and tag library
//!   are a later slice's. Its address is resolved first, so an address
//!   nothing answers to is refused exactly as the TypeScript refuses it.

use serde_json::{Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_mcp::{Identity, OpsCatalogue, Server};
use whiteboard_ops::Ports;
use whiteboard_port_fakes::{
    FixedCaller, MemoryRecordStore, MemoryRegistry, MemoryVersionStore, block_on,
};
use whiteboard_ports::WorkspaceEntry;

const CASES: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/facet-list.jsonl");

/// The calls naming a workspace that resolves, answered as pending.
const PENDING: usize = 3;

struct Fakes(MemoryRegistry, FixedCaller);

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;

    fn records(&self) -> &MemoryRecordStore {
        unreachable!("a facet listing reads no record")
    }

    fn registry(&self) -> &MemoryRegistry {
        &self.0
    }

    fn caller(&self) -> &FixedCaller {
        &self.1
    }

    fn versions(&self) -> &MemoryVersionStore {
        unreachable!("a facet listing lists no version")
    }
}

#[cfg(test)]
fn server(record: &Value) -> Server<OpsCatalogue<Fakes>> {
    let text = |row: &Value, key: &str| row.get(key).map(|v| v.as_str().expect("text").to_owned());
    let registry = record["registry"].as_array().expect("registry rows").iter().fold(
        MemoryRegistry::new(),
        |registry, row| {
            registry.holding(WorkspaceEntry {
                workspace_id: text(row, "workspaceId").expect("an id"),
                namespace: text(row, "namespace"),
                segment: text(row, "segment"),
            })
        },
    );
    let known = record["known"].as_array().expect("known handles");
    let caller = FixedCaller::new()
        .in_namespace(record["callerNamespace"].as_str().expect("a namespace"))
        .knowing(known.iter().map(|h| h.as_str().expect("a handle").to_owned()).collect());
    let identity =
        Identity { name: "whiteboard".into(), version: "0".into(), instructions: String::new() };
    Server::new(identity, OpsCatalogue::new(Fakes(registry, caller)))
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
    let (mut replayed, mut pending) = (0, 0);
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
        if row["params"]["arguments"].get("workspaceId").is_some() {
            let missing = "Tool wb_facet_list not found";
            assert_eq!(answer["error"]["message"], json!(missing), "{case}");
            pending += 1;
            continue;
        }
        let result = &answer["result"];
        let said = first_text(result);
        let parsed: Value = serde_json::from_str(&said).expect("JSON text");
        assert_eq!(result["structuredContent"], parsed, "{case}: the text spells the structure");
        assert_eq!(said, first_text(held), "{case}");
    }
    assert_eq!(replayed, 24, "the recording's calls, every one answered");
    assert_eq!(pending, PENDING, "the declared difference");
}
