//! `wb_document_list` and the `/api/v1` resolve held to the TypeScript's answers
//! for the same records.
//!
//! `packages/mcp-server/src/server/mcp/oracle/document-reads.jsonl` is
//! recorded by
//! `packages/mcp-server/src/server/mcp/tool-contracts.oracle.test.ts`, which
//! runs server-core's `wbDocumentList` as `createServer`'s tool record calls
//! it (the address resolved first) and its `wbDocumentResolve`, over
//! `LoroWorkspaceDocumentIndex`. A row with a `snapshot` is a workspace record
//! kept as `W` (`null`: the keeper holds none) with the registry rows that
//! address it, the caller's namespace and the handles a refusal may name; each
//! row after it is one call over that record with the answer, `ok` with the
//! output or `err` with the class thrown and its message. A refusal is held
//! to the message exactly and to the code `refusals.json` gives the class it
//! was thrown as.

use serde_json::{Map, Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_api_contracts::Refusal;
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_ops::{
    DocumentDetail, DocumentList, DocumentListInput, DocumentListOutput, DocumentResolve,
    DocumentResolveInput, Operation, Ports, with_resolved_workspace,
};
use whiteboard_port_fakes::{
    FixedCaller, MemoryRecordStore, MemoryRegistry, MemoryVersionStore, block_on,
};
use whiteboard_ports::WorkspaceEntry;

const CASES: &str =
    include_str!("../../../../packages/mcp-server/src/server/mcp/oracle/document-reads.jsonl");
const CONTRACT: &str = include_str!("../../../../contracts/api/refusals.json");

/// The ports these reads need: the record store, the registry and the caller.
struct Fakes(MemoryRecordStore, MemoryRegistry, FixedCaller);

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;

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
}

/// The record store alone, its workspace in the registry; the caller `me`,
/// told of nothing.
#[cfg(test)]
fn over(records: MemoryRecordStore) -> Fakes {
    let registry = MemoryRegistry::new().holding(entry(&json!({ "workspaceId": W })));
    Fakes(records, registry, FixedCaller::new())
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
    Fakes(records, registry, caller)
}

#[cfg(test)]
fn rows() -> Vec<Value> {
    CASES.lines().map(|line| serde_json::from_str(line).expect("a JSON row")).collect()
}

/// The code `refusals.json` answers a TypeScript error class with.
#[cfg(test)]
fn code_of_class(class: &str) -> String {
    let contract: Value = serde_json::from_str(CONTRACT).expect("the contract parses");
    let codes: Vec<&str> = contract["refusals"]
        .as_array()
        .expect("a refusal list")
        .iter()
        .filter(|entry| entry["source"].as_str().is_some_and(|s| s.split(", ").any(|c| c == class)))
        .filter_map(|entry| entry["code"].as_str())
        .collect();
    assert!(!codes.is_empty(), "refusals.json names no refusal thrown as {class}");
    assert!(codes.iter().all(|c| *c == codes[0]), "{class} is answered with several codes");
    codes[0].to_owned()
}

fn detail(detail: &DocumentDetail) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("documentId".into(), json!(detail.document_id));
    out.insert("path".into(), json!(detail.path));
    if let Some(name) = &detail.name {
        out.insert("name".into(), json!(name));
    }
    if let Some(kind) = &detail.kind {
        out.insert("kind".into(), json!(kind));
    }
    if let Some(updated_at) = &detail.updated_at {
        out.insert("updatedAt".into(), json!(updated_at));
    }
    if detail.shadowed {
        out.insert("shadowed".into(), json!(true));
    }
    out
}

fn list_json(output: &DocumentListOutput) -> Value {
    let documents: Vec<Value> = output
        .documents
        .iter()
        .map(|listed| {
            let mut out = detail(&listed.detail);
            out.insert("pinned".into(), json!(listed.pinned));
            Value::Object(out)
        })
        .collect();
    let mut out = Map::new();
    out.insert("documents".into(), Value::Array(documents));
    if !output.folder_names.is_empty() {
        let names: Vec<Value> = output
            .folder_names
            .iter()
            .map(|folder| json!({ "path": folder.path, "name": folder.name }))
            .collect();
        out.insert("folderNames".into(), Value::Array(names));
    }
    Value::Object(out)
}

fn answer<T>(result: Result<T, Refusal>, ok: impl Fn(&T) -> Value) -> Value {
    match result {
        Ok(output) => json!({ "ok": ok(&output) }),
        Err(refusal) => json!({ "err": { "code": refusal.code(), "message": refusal.message() } }),
    }
}

/// The recorded answer with the class replaced by the code it travels as.
#[cfg(test)]
fn expected(row: &Value) -> Value {
    let expect = &row["expect"];
    match expect.get("err") {
        Some(err) => json!({ "err": {
            "code": code_of_class(err["class"].as_str().expect("a class")),
            "message": err["message"],
        }}),
        None => expect.clone(),
    }
}

/// One call row answered over `ports`: the listing through the address, as
/// the tool record calls it, and the resolve over `W`, as the route calls it.
#[cfg(test)]
fn answered(ports: &Fakes, row: &Value) -> Value {
    match row["op"].as_str() {
        Some("list") => {
            let handle = row["workspaceId"].as_str().expect("an address");
            let listed = with_resolved_workspace(ports, handle, |workspace_id| {
                DocumentList::execute(ports, DocumentListInput { workspace_id })
            });
            answer(block_on(listed), list_json)
        }
        Some("resolve") => {
            let document_id = row["documentId"].as_str().expect("an id").to_owned();
            let input = DocumentResolveInput { workspace_id: W.to_owned(), document_id };
            answer(block_on(DocumentResolve::execute(ports, input)), |found| {
                Value::Object(detail(found))
            })
        }
        other => panic!("{}: an operation the recorder did not record: {other:?}", row["case"]),
    }
}

#[test]
fn every_call_answers_as_the_typescript_answered_it() {
    let mut ports = over(MemoryRecordStore::new());
    let mut checked = 0;
    for row in rows() {
        if row.get("snapshot").is_some() {
            ports = fakes_of(&row);
            continue;
        }
        assert_eq!(answered(&ports, &row), expected(&row), "{}: {}", row["case"], row["op"]);
        checked += 1;
    }
    assert_eq!(checked, 34, "the recording's calls, every one replayed");
}

const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const D: &str = "01ARZ3NDEKTSV4RRFFQ69G5FZZ";

#[cfg(test)]
fn both(ports: &Fakes) -> [Refusal; 2] {
    let listed = DocumentList::execute(ports, DocumentListInput { workspace_id: W.to_owned() });
    let resolve = DocumentResolveInput { workspace_id: W.to_owned(), document_id: D.to_owned() };
    let resolved = DocumentResolve::execute(ports, resolve);
    // Natively the futures cross threads, which a daemon's executor needs.
    #[cfg(not(target_arch = "wasm32"))]
    {
        fn sendable<T: Send>(_: &T) {}
        sendable(&listed);
        sendable(&resolved);
    }
    [
        block_on(listed).expect_err("the listing is refused"),
        block_on(resolved).expect_err("the resolve is refused"),
    ]
}

#[test]
fn a_record_whose_bytes_do_not_import_is_refused_as_damaged_by_both_reads() {
    let ports = over(MemoryRecordStore::new().holding(W, b"not a loro snapshot".to_vec()));
    for refusal in both(&ports) {
        assert_eq!(refusal.code(), "corrupt_stored_data");
        assert_eq!(refusal.status(), 500);
        let message = refusal.message();
        let prefix = format!("stored workspace document {W} could not be imported: ");
        assert!(message.starts_with(&prefix) && message.len() > prefix.len(), "{message}");
    }
}

#[test]
fn a_store_that_fails_is_answered_with_its_own_refusal_by_both_reads() {
    let ports = over(MemoryRecordStore::failing(whiteboard_ports::PortError::DatabaseBusy));
    for refusal in both(&ports) {
        assert_eq!(refusal, Refusal::DatabaseBusy);
    }
    let gone = whiteboard_ports::PortError::WorkspaceNotFound { workspace_id: W.to_owned() };
    let [listed, resolved] = both(&over(MemoryRecordStore::failing(gone)));
    assert_eq!(listed, Refusal::WorkspaceNotFoundForCallerRead { workspace_id: W.to_owned() });
    assert_eq!(resolved, Refusal::WorkspaceNotFoundInIndex { workspace_id: W.to_owned() });
}
