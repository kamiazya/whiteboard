//! What the recording cannot show of a viewport request: what the pages are
//! handed, and that a refused call hands them nothing.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_port_fakes::{
    FixedCaller, KeyedLock, MemoryRecordStore, MemoryRegistry, MemoryVersionStore,
    RecordingNotifier, block_on,
};
use whiteboard_ports::{PortError, ViewportMode};

// Marked as test code where it is, so repro-check's scan for what production
// embeds does not read the recording as an input of the shipped build.
#[cfg(test)]
const CASES: &str =
    include_str!("../../../../../packages/mcp-server/src/server/mcp/oracle/viewport-set.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

struct Fakes {
    records: MemoryRecordStore,
    notifier: RecordingNotifier,
}

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;
    type Lock = KeyedLock;
    type Notifier = RecordingNotifier;

    fn records(&self) -> &MemoryRecordStore {
        &self.records
    }

    fn registry(&self) -> &MemoryRegistry {
        unreachable!("the address was resolved before the call")
    }

    fn caller(&self) -> &FixedCaller {
        unreachable!("the address was resolved before the call")
    }

    fn versions(&self) -> &MemoryVersionStore {
        unreachable!("a viewport request reads no version")
    }

    fn lock(&self) -> &KeyedLock {
        unreachable!("a viewport request takes no lock")
    }

    fn notifier(&self) -> &RecordingNotifier {
        &self.notifier
    }
}

/// The recording's record, a page on `board`, and the documents' ids by path.
fn fakes() -> (Fakes, serde_json::Value) {
    let line = CASES.lines().next().expect("a record row");
    let row: serde_json::Value = serde_json::from_str(line).expect("JSON");
    let bytes = base64_to_bytes(row["snapshot"].as_str().expect("a snapshot")).expect("base64");
    let ids = row["ids"].clone();
    let board = ids["board"].as_str().expect("an id");
    let fakes = Fakes {
        records: MemoryRecordStore::new().holding(W, bytes),
        notifier: RecordingNotifier::new().watching(W, board),
    };
    (fakes, ids)
}

fn request(document_id: &serde_json::Value) -> ViewportRequest {
    ViewportRequest {
        workspace_id: W.to_owned(),
        document_id: document_id.as_str().expect("an id").to_owned(),
        mode: None,
        element_ids: None,
        scroll_x: None,
        scroll_y: None,
        zoom: None,
    }
}

#[test]
fn the_pages_are_handed_the_request_as_it_was_asked() {
    let (fakes, ids) = fakes();
    let framed = ViewportRequest {
        mode: Some(ViewportMode::Fit),
        element_ids: Some(vec!["tower".to_owned(), "pad".to_owned()]),
        ..request(&ids["board"])
    };
    let moved = ViewportRequest {
        mode: Some(ViewportMode::Move),
        scroll_x: Some(-1.5),
        scroll_y: Some(2.0),
        zoom: Some(0.5),
        ..request(&ids["quiet"])
    };
    let told = block_on(ViewportSet::execute(&fakes, framed.clone()));
    let document_id = framed.document_id.clone();
    assert_eq!(told, Ok(ViewportSetAnswer::Told { document_id, delivered: true }));
    let unwatched = block_on(ViewportSet::execute(&fakes, moved.clone()));
    let document_id = moved.document_id.clone();
    assert_eq!(unwatched, Ok(ViewportSetAnswer::Told { document_id, delivered: false }));
    assert_eq!(fakes.notifier.requests(), [framed, moved]);
}

#[test]
fn a_refused_request_reaches_no_page() {
    let (fakes, ids) = fakes();
    let ghost = ViewportRequest {
        element_ids: Some(vec!["pad".to_owned(), "ghost".to_owned()]),
        ..request(&ids["board"])
    };
    let refused = block_on(ViewportSet::execute(&fakes, ghost.clone()));
    let node_id = "ghost".to_owned();
    assert_eq!(refused, Err(Refusal::NodeNotFound { document_id: ghost.document_id, node_id }));
    let note = block_on(ViewportSet::execute(&fakes, request(&ids["note"])));
    assert!(matches!(note, Err(Refusal::DocumentKindMismatch { .. })), "{note:?}");
    let nothing = serde_json::Value::from("01BX5ZZKBKACTAV9WEVGEMMVRZ");
    let unknown = block_on(ViewportSet::execute(&fakes, request(&nothing)));
    assert!(matches!(unknown, Err(Refusal::DocumentNotFound { .. })), "{unknown:?}");
    assert!(fakes.notifier.requests().is_empty());
}

#[test]
fn a_workspace_the_store_holds_no_record_of_is_refused() {
    let (_, ids) = fakes();
    let fakes = Fakes { records: MemoryRecordStore::new(), notifier: RecordingNotifier::new() };
    let refused = block_on(ViewportSet::execute(&fakes, request(&ids["board"])));
    let workspace_id = W.to_owned();
    assert_eq!(refused, Err(Refusal::from(&PortError::WorkspaceNotFound { workspace_id })));
    assert!(fakes.notifier.requests().is_empty());
}
