//! The engine paths the recording cannot reach, over its own record.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::encoding::base64_to_bytes;

// Marked as test code where it is, so repro-check's scan for what production
// embeds does not read the recording as an input of the shipped build.
#[cfg(test)]
const CASES: &str =
    include_str!("../../../../../packages/mcp-server/src/server/mcp/oracle/document-get.jsonl");

/// The recording's record, and its documents' ids by name.
fn recorded() -> (WorkspaceRecord, serde_json::Value) {
    let line = CASES.lines().next().expect("a record row");
    let row: serde_json::Value = serde_json::from_str(line).expect("JSON");
    let bytes = base64_to_bytes(row["snapshot"].as_str().expect("a snapshot")).expect("base64");
    (WorkspaceRecord::open(&bytes).expect("a record"), row["ids"].clone())
}

#[test]
fn a_kind_is_the_documents_own_before_its_index_rows() {
    let stated = Some(Value::String("spatial".to_owned()));
    assert_eq!(kind_of(stated, Some("markdown".to_owned())).as_deref(), Some("spatial"));
    assert_eq!(
        kind_of(Some(Value::Null), Some("markdown".to_owned())).as_deref(),
        Some("markdown")
    );
    assert_eq!(kind_of(None, None), None);
}

#[test]
fn a_document_with_no_kind_at_all_names_the_repair() {
    let reason = kind_unknown("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert!(reason.starts_with("Document 01ARZ3NDEKTSV4RRFFQ69G5FAV records no kind"));
    assert!(reason.ends_with("refused unless the document is empty."));
}

#[test]
fn a_refusal_the_operation_does_not_restore_is_the_engines_own_error() {
    let (record, _) = recorded();
    let hosted = Hosted { record: &record, document_id: "01BX5ZZKBKACTAV9WEVGEMMVRZ" };
    let refused = hosted.read(QueryName::DocumentKind, &[]);
    let message = "documentKind was refused: Error".to_owned();
    assert_eq!(refused, Err(Fault::Stop(Stop::Refused(Refusal::CorruptStoredData { message }))));
}

#[test]
fn a_read_the_record_leaves_to_its_caller_is_pending() {
    let (record, ids) = recorded();
    let id = ids["bare"].as_str().expect("an id");
    let hosted = Hosted { record: &record, document_id: id };
    let asked = hosted.read(QueryName::DocumentContentWithTags, &[("kind", Value::Bool(true))]);
    let pending = Pending::UndecidedRead(id.to_owned());
    assert_eq!(asked, Err(Fault::Stop(Stop::Pending(pending))));
}

#[test]
fn a_spatial_document_is_pending() {
    let (record, ids) = recorded();
    let id = ids["board"].as_str().expect("an id");
    let read = read_one(Hosted { record: &record, document_id: id });
    assert_eq!(read, Err(Stop::Pending(Pending::JsonCanvas(id.to_owned()))));
}

#[test]
fn a_repeated_id_is_read_once_where_it_first_appears() {
    let (record, ids) = recorded();
    let (bare, plan) = (ids["bare"].as_str().expect("id"), ids["plan"].as_str().expect("id"));
    let asked = [bare, plan, bare].map(str::to_owned).to_vec();
    let output = read_all(&record, asked).expect("an answer");
    let read: Vec<&str> = output.documents.iter().map(|d| d.document_id.as_str()).collect();
    assert_eq!(read, [bare, plan]);
}

#[test]
fn a_document_neither_its_content_nor_its_index_row_gives_a_kind_is_failed() {
    let (record, ids) = recorded();
    let id = ids["kindless"].as_str().expect("an id");
    let read = read_known(Hosted { record: &record, document_id: id }, None, None);
    assert_eq!(read, Ok(Err(kind_unknown(id))));
}

#[test]
fn a_workspace_the_store_holds_no_record_of_is_refused() {
    use whiteboard_port_fakes::{FixedCaller, MemoryRecordStore, MemoryRegistry, block_on};

    struct Empty(MemoryRecordStore, MemoryRegistry, FixedCaller);
    impl Ports for Empty {
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
    let ports = Empty(MemoryRecordStore::new(), MemoryRegistry::new(), FixedCaller::new());
    let input =
        DocumentGetInput { workspace_id: "w".to_owned(), document_ids: vec!["d".to_owned()] };
    let refused = block_on(DocumentGet::execute(&ports, input));
    assert_eq!(refused, Err(Refusal::WorkspaceNotFoundInIndex { workspace_id: "w".to_owned() }));
}
