//! `wb_document_list` and the `/api/v1` resolve held to the TypeScript's answers
//! for the same records.
//!
//! `fixtures/document_reads.jsonl` was recorded by running server-core's own
//! `wbDocumentList` and `wbDocumentResolve` over `LoroWorkspaceDocumentIndex`:
//! a row with a `snapshot` is a workspace record (`null`: the keeper holds no
//! such workspace), and each row after it one call over that record with the
//! answer, `ok` with the output or `err` with the class thrown and its message.
//! A refusal is held to the message exactly and to the code `refusals.json`
//! gives the class it was thrown as.

use serde_json::{Map, Value, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_api_contracts::Refusal;
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_ops::{
    DocumentDetail, DocumentList, DocumentListInput, DocumentListOutput, DocumentResolve,
    DocumentResolveInput, Operation, Ports,
};
use whiteboard_port_fakes::{MemoryRecordStore, block_on};

const CASES: &str = include_str!("fixtures/document_reads.jsonl");
const CONTRACT: &str = include_str!("../../../../contracts/api/refusals.json");

/// The ports these reads need: the record store alone.
struct Fakes(MemoryRecordStore);

impl Ports for Fakes {
    type Records = MemoryRecordStore;

    fn records(&self) -> &MemoryRecordStore {
        &self.0
    }
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

#[test]
fn every_call_answers_as_the_typescript_answered_it() {
    let mut store = Fakes(MemoryRecordStore::new());
    let mut checked = 0;
    for row in rows() {
        let workspace_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV".to_owned();
        if let Some(snapshot) = row.get("snapshot") {
            store = Fakes(match snapshot.as_str() {
                Some(text) => MemoryRecordStore::new()
                    .holding(&workspace_id, base64_to_bytes(text).expect("base64")),
                None => MemoryRecordStore::new(),
            });
            continue;
        }
        let case = row["case"].as_str().expect("a case");
        let answered = match row["op"].as_str() {
            Some("list") => answer(
                block_on(DocumentList::execute(&store, DocumentListInput { workspace_id })),
                list_json,
            ),
            Some("resolve") => {
                let document_id = row["documentId"].as_str().expect("an id").to_owned();
                let input = DocumentResolveInput { workspace_id, document_id };
                answer(block_on(DocumentResolve::execute(&store, input)), |found| {
                    Value::Object(detail(found))
                })
            }
            other => panic!("{case}: an operation the probe did not record: {other:?}"),
        };
        assert_eq!(answered, expected(&row), "{case}: {}", row["op"]);
        checked += 1;
    }
    assert_eq!(checked, 18, "the recording's calls, every one replayed");
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
    let ports = Fakes(MemoryRecordStore::new().holding(W, b"not a loro snapshot".to_vec()));
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
    let ports = Fakes(MemoryRecordStore::failing(whiteboard_ports::PortError::DatabaseBusy));
    for refusal in both(&ports) {
        assert_eq!(refusal, Refusal::DatabaseBusy);
    }
    let gone = whiteboard_ports::PortError::WorkspaceNotFound { workspace_id: W.to_owned() };
    let [listed, resolved] = both(&Fakes(MemoryRecordStore::failing(gone)));
    assert_eq!(listed, Refusal::WorkspaceNotFoundForCallerRead { workspace_id: W.to_owned() });
    assert_eq!(resolved, Refusal::WorkspaceNotFoundInIndex { workspace_id: W.to_owned() });
}
