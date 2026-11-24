//! `wb_document_get` held to what the daemon answered over a workspace record
//! with content.
//!
//! `packages/mcp-server/src/server/mcp/oracle/document-get.jsonl` is recorded
//! by `document-get.oracle.test.ts` beside it: its first row is the record
//! (kept as `W`, with the registry rows that address it and the ids of its
//! documents by name), and every row after it one `tools/call` and the result
//! the TypeScript server drew, answered over a real data directory the record
//! was loaded into. A result's `structuredContent` is held as `structured:
//! true`, being what its text spells; the text is held byte for byte, key
//! order included: the engine reads an object the TypeScript parses through a
//! schema in that schema's order.

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
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/document-get.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

struct Fakes(MemoryRecordStore, MemoryRegistry, FixedCaller);

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
        unreachable!("a document read lists no version")
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
fn entry(row: &Value) -> WorkspaceEntry {
    let text = |key: &str| row.get(key).map(|v| v.as_str().expect("a string").to_owned());
    WorkspaceEntry {
        workspace_id: text("workspaceId").expect("an id"),
        namespace: text("namespace"),
        segment: text("segment"),
    }
}

#[cfg(test)]
fn server(record: &Value) -> Server<OpsCatalogue<Fakes>> {
    let bytes = base64_to_bytes(record["snapshot"].as_str().expect("a snapshot")).expect("base64");
    let registry = record["registry"]
        .as_array()
        .expect("registry rows")
        .iter()
        .fold(MemoryRegistry::new(), |registry, row| registry.holding(entry(row)));
    let caller =
        FixedCaller::new().in_namespace(record["callerNamespace"].as_str().expect("a namespace"));
    let fakes = Fakes(MemoryRecordStore::new().holding(W, bytes), registry, caller);
    let identity =
        Identity { name: "whiteboard".into(), version: "0".into(), instructions: String::new() };
    Server::new(identity, OpsCatalogue::new(fakes))
}

#[cfg(test)]
/// The recorded result as the wire carried it, its structured half parsed
/// back from its text.
fn expected(answer: &Value) -> Value {
    let mut answer = answer.clone();
    let structured = answer.as_object_mut().expect("a result").remove("structured");
    if structured == Some(Value::Bool(true)) {
        let text = answer["content"][0]["text"].as_str().expect("a text");
        answer["structuredContent"] = serde_json::from_str(text).expect("JSON text");
    }
    answer
}

#[cfg(test)]
/// A result without its content and structured output.
fn rest(result: &Value) -> Value {
    let mut rest = result.clone();
    let members = rest.as_object_mut().expect("a result");
    members.remove("content");
    members.remove("structuredContent");
    rest
}

#[test]
fn every_recorded_call_is_answered_as_the_daemon_answered_it() {
    let mut lines = CASES.lines();
    let record: Value = serde_json::from_str(lines.next().expect("a record")).expect("JSON");
    let server = server(&record);
    let mut replayed = 0;
    for (id, line) in lines.enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        let message =
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": row["params"] });
        let answer = block_on(server.handle(&message)).expect("an answer");
        let case = row["case"].as_str().expect("a case");
        let expected = expected(&row["answer"]);
        let result = &answer["result"];
        if expected.get("structuredContent").is_some() {
            let text =
                |answer: &Value| answer["content"][0]["text"].as_str().expect("a text").to_owned();
            let (held, said) = (text(&expected), text(result));
            let parsed: Value = serde_json::from_str(&said).expect("JSON text");
            assert_eq!(
                result["structuredContent"], parsed,
                "{case}: the text spells the structure"
            );
            assert_eq!(said, held, "{case}: the text, byte for byte");
            assert_eq!(rest(result), rest(&expected), "{case}");
        } else {
            assert_eq!(result, &expected, "{case}");
        }
        replayed += 1;
    }
    assert_eq!(replayed, 48, "the recording's calls, every one answered");
}
