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
//! Two differences are declared rather than reproduced, each counted:
//!
//! - [`SCHEMA`]: a facet's payload schema is served as its contract writes
//!   it, `x-wb-*` dropped and local references inlined (owner decision q48),
//!   where the TypeScript serves `z.toJSONSchema` of the generated Zod. Such
//!   an answer is compared byte for byte with every facet's `schema` member
//!   cut out of both texts.
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

/// The listings answered with each facet's contract as its schema.
const SCHEMA: usize = 10;
/// The calls naming a workspace that resolves, answered as pending.
const PENDING: usize = 3;

struct Fakes(MemoryRegistry, FixedCaller);

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;
    type Lock = whiteboard_port_fakes::KeyedLock;

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

    fn lock(&self) -> &whiteboard_port_fakes::KeyedLock {
        unreachable!("a read takes no lock")
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

/// The end of the JSON value that starts at `start`, a string's escapes and
/// the brackets inside strings skipped.
#[cfg(test)]
fn value_end(text: &str, start: usize) -> usize {
    let (mut depth, mut quoted, mut escaped) = (0usize, false, false);
    for (offset, byte) in text.bytes().enumerate().skip(start) {
        match (quoted, escaped, byte) {
            (true, true, _) => escaped = false,
            (true, false, b'\\') => escaped = true,
            (true, false, b'"') => quoted = false,
            (false, _, b'"') => quoted = true,
            (false, _, b'{' | b'[') => depth += 1,
            (false, _, b'}' | b']') => {
                depth -= 1;
                if depth == 0 {
                    return offset + 1;
                }
            }
            _ => {}
        }
    }
    text.len()
}

/// The text with every `,"schema":<value>` member cut out.
#[cfg(test)]
fn without_schemas(text: &str) -> String {
    const MEMBER: &str = ",\"schema\":";
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(MEMBER) {
        out.push_str(&rest[..at]);
        let end = value_end(rest, at + MEMBER.len());
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
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
    let (mut replayed, mut schema, mut pending) = (0, 0, 0);
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
        assert_eq!(without_schemas(&said), without_schemas(&first_text(held)), "{case}");
        assert_ne!(said, first_text(held), "{case}: a schema the TypeScript serves alike");
        schema += 1;
    }
    assert_eq!(replayed, 24, "the recording's calls, every one answered");
    assert_eq!((schema, pending), (SCHEMA, PENDING), "the declared differences");
}

/// Every served schema is one a JSON Schema reader reads alone: no dialect
/// member and no reference into the contract left, and the same members
/// required as the TypeScript's.
#[test]
fn every_served_schema_stands_alone_and_requires_what_the_typescript_requires() {
    let record: Value =
        serde_json::from_str(CASES.lines().next().expect("a record")).expect("JSON");
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": "wb_facet_list" } });
    let answer = block_on(server(&record).handle(&call)).expect("an answer");
    let held: Value = CASES
        .lines()
        .skip(1)
        .map(|line| serde_json::from_str::<Value>(line).expect("a row"))
        .find(|row| row["params"].get("arguments").is_none())
        .map(|row| serde_json::from_str(&first_text(&row["answer"])).expect("JSON"))
        .expect("the call with no arguments");
    let facets = answer["result"]["structuredContent"]["facets"].as_array().expect("facets");
    assert_eq!(facets.len(), 11);
    for (served, typescript) in facets.iter().zip(held["facets"].as_array().expect("facets")) {
        let text = served["schema"].to_string();
        assert!(!text.contains("\"x-wb-") && !text.contains("#/$defs/"), "{}", served["key"]);
        // An empty list the contract writes is the absent one Zod writes.
        let required = |schema: &Value| match &schema["required"] {
            Value::Null => json!([]),
            listed => listed.clone(),
        };
        assert_eq!(required(&served["schema"]), required(&typescript["schema"]));
        assert_eq!(served["schema"].get("type"), typescript["schema"].get("type"));
    }
}

#[test]
fn a_schema_member_is_cut_however_its_strings_are_bracketed() {
    let text = r#"{"a":[{"k":1,"schema":{"s":"}]\"{","t":[1,{}]},"z":2},{"k":2}]}"#;
    assert_eq!(without_schemas(text), r#"{"a":[{"k":1,"z":2},{"k":2}]}"#);
    assert_eq!(without_schemas("{\"k\":1}"), "{\"k\":1}");
}
