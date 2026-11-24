//! `wb_document_get` held to what the daemon answered over a workspace record
//! with content.
//!
//! `packages/mcp-server/src/server/mcp/oracle/document-get.jsonl` is recorded
//! by `document-get.oracle.test.ts` beside it: its first row is the record
//! (kept as `W`, with the registry rows that address it and the ids of its
//! documents by name), and every row after it one `tools/call` and the result
//! the TypeScript server drew, answered over a real data directory the record
//! was loaded into. A result's `structuredContent` is held as `structured:
//! true`, being what its text spells; the text is held byte for byte.
//!
//! One difference is declared rather than reproduced: the ORDER of the keys
//! of an object the engine reads back. The TypeScript's readers build a
//! thread, a proposal and the core and trust facets in their schemas' order
//! and hand a free map (a facet's payload) over in npm loro-crdt's order,
//! while `whiteboard-crdt` answers every object with its keys ascending. So a
//! text is compared byte for byte where it can be, and otherwise as the same
//! JSON with each markdown document's OKF text compared as the same document
//! ([`same_document`]); [`KEY_ORDER`] counts the calls that need it, and
//! falls to none when the engine answers in the TypeScript's order.
//!
//! The calls that reach a spatial document's JSON Canvas are answered as a
//! pending tool is ([`PENDING`]), the part of `DocumentGet` that is not ported
//! yet.

use serde_json::{Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_codec::okf;
use whiteboard_mcp::{Identity, OpsCatalogue, Server};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_ops::Ports;
use whiteboard_port_fakes::{FixedCaller, MemoryRecordStore, MemoryRegistry, block_on};
use whiteboard_ports::WorkspaceEntry;

const CASES: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/document-get.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/// The recorded calls that read a spatial document, whose JSON Canvas is not
/// ported yet.
const PENDING: [&str; 2] = ["a spatial document", "a spatial document, strict"];

/// How many recorded calls are answered with the same JSON in another key
/// order (see the module's note).
const KEY_ORDER: usize = 12;

struct Fakes(MemoryRecordStore, MemoryRegistry, FixedCaller);

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;

    fn records(&self) -> &MemoryRecordStore {
        &self.0
    }

    fn registry(&self) -> &MemoryRegistry {
        &self.1
    }

    fn caller(&self) -> &FixedCaller {
        &self.2
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
/// A value with every map's keys ascending.
fn sorted(value: whiteboard_model::Value) -> whiteboard_model::Value {
    use whiteboard_model::Value as Plain;
    match value {
        Plain::Seq(items) => Plain::Seq(items.into_iter().map(sorted).collect()),
        Plain::Map(entries) => {
            let mut entries: Vec<_> = entries.into_iter().map(|(k, v)| (k, sorted(v))).collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Plain::Map(entries)
        }
        other => other,
    }
}

#[cfg(test)]
/// An OKF text written again from what it parses to, every free map's keys
/// ascending: two texts that say the same document in another key order are
/// the same text here.
fn same_document(text: &str) -> String {
    let mut document = okf::parse(text).expect("an OKF text");
    let sort = |map: Option<Vec<(String, whiteboard_model::Value)>>| {
        map.map(|map| match sorted(whiteboard_model::Value::Map(map)) {
            whiteboard_model::Value::Map(map) => map,
            _ => unreachable!("a map sorts to a map"),
        })
    };
    document.frontmatter.facets = sort(document.frontmatter.facets.take());
    document.frontmatter.facets_raw = sort(document.frontmatter.facets_raw.take());
    okf::serialize(&document).expect("a writable document")
}

#[cfg(test)]
/// A result's text as JSON, each markdown document's content as
/// [`same_document`] writes it.
fn canonical(text: &str) -> Value {
    let mut answer: Value = serde_json::from_str(text).expect("JSON text");
    for document in answer["documents"].as_array_mut().into_iter().flatten() {
        if document["kind"] == "markdown" {
            let content = same_document(document["content"].as_str().expect("a content"));
            document["content"] = Value::from(content);
        }
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
    let (mut replayed, mut pending, mut reordered) = (0, 0, 0);
    for (id, line) in lines.enumerate() {
        let row: Value = serde_json::from_str(line).expect("a JSON row");
        let message =
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": row["params"] });
        let answer = block_on(server.handle(&message)).expect("an answer");
        let case = row["case"].as_str().expect("a case");
        if PENDING.contains(&case) {
            assert_eq!(
                answer["error"]["message"],
                json!("Tool wb_document_get not found"),
                "{case}"
            );
            pending += 1;
            continue;
        }
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
            if said != held {
                assert_eq!(canonical(&said), canonical(&held), "{case}");
                reordered += 1;
            }
            assert_eq!(rest(result), rest(&expected), "{case}");
        } else {
            assert_eq!(result, &expected, "{case}");
        }
        replayed += 1;
    }
    assert_eq!(
        (replayed, pending),
        (37, PENDING.len()),
        "the recording's calls, every one answered"
    );
    assert_eq!(reordered, KEY_ORDER, "the calls answered in another key order");
}
