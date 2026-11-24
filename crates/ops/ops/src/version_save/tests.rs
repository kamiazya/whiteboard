//! What the recording cannot show of a save: the lock it holds, and what it
//! writes when the store fails part way.

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_port_fakes::{
    FixedCaller, KeyedLock, MemoryRecordStore, MemoryRegistry, MemoryVersionStore, block_on,
};
use whiteboard_ports::{PortError, SavedVersion, VersionStore, WorkspaceLock};

// Marked as test code where it is, so repro-check's scan for what production
// embeds does not read the recording as an input of the shipped build.
#[cfg(test)]
const CASES: &str =
    include_str!("../../../../../packages/mcp-server/src/server/mcp/oracle/version-save.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

struct Fakes {
    records: MemoryRecordStore,
    versions: MemoryVersionStore,
    lock: KeyedLock,
}

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;
    type Lock = KeyedLock;
    type Notifier = whiteboard_port_fakes::RecordingNotifier;

    fn records(&self) -> &MemoryRecordStore {
        &self.records
    }

    fn registry(&self) -> &MemoryRegistry {
        unreachable!("the address was resolved before the save")
    }

    fn caller(&self) -> &FixedCaller {
        unreachable!("the address was resolved before the save")
    }

    fn versions(&self) -> &MemoryVersionStore {
        &self.versions
    }

    fn lock(&self) -> &KeyedLock {
        &self.lock
    }

    fn notifier(&self) -> &whiteboard_port_fakes::RecordingNotifier {
        unreachable!("this call tells no page")
    }
}

/// The recording's record over `versions`, and its documents' ids by name.
fn fakes(versions: MemoryVersionStore) -> (Fakes, serde_json::Value) {
    let line = CASES.lines().next().expect("a record row");
    let row: serde_json::Value = serde_json::from_str(line).expect("JSON");
    let bytes = base64_to_bytes(row["snapshot"].as_str().expect("a snapshot")).expect("base64");
    let records = MemoryRecordStore::new().holding(W, bytes);
    (Fakes { records, versions, lock: KeyedLock::new() }, row["ids"].clone())
}

fn input(ids: &[&serde_json::Value], label: &str) -> VersionSaveInput {
    VersionSaveInput {
        workspace_id: W.to_owned(),
        document_ids: ids.iter().map(|id| id.as_str().expect("an id").to_owned()).collect(),
        label: label.to_owned(),
    }
}

fn listed(fakes: &Fakes, id: &serde_json::Value) -> Vec<String> {
    let id = id.as_str().expect("an id");
    let listed = block_on(fakes.versions.list(W, id)).expect("a listing");
    listed.into_iter().map(|version| version.id).collect()
}

#[test]
fn each_document_is_saved_in_the_order_asked_under_the_one_label() {
    let versions = MemoryVersionStore::new()
        .minting(vec!["a".to_owned(), "b".to_owned(), "c".to_owned()], "2026-11-24T12:00:00.000Z");
    let (fakes, ids) = fakes(versions);
    let asked = input(&[&ids["board"], &ids["plan"], &ids["board"]], "together");
    let output = block_on(VersionSave::execute(&fakes, asked.clone())).expect("a save");
    let answered: Vec<(&str, &str, Option<&str>)> = output
        .saved
        .iter()
        .map(|s| (s.document_id.as_str(), s.version.id.as_str(), s.version.label.as_deref()))
        .collect();
    let [board, plan, again] = [0, 1, 2].map(|at| asked.document_ids[at].as_str());
    assert_eq!(
        answered,
        [
            (board, "a", Some("together")),
            (plan, "b", Some("together")),
            (again, "c", Some("together"))
        ]
    );
    assert!(output.saved.iter().all(|saved| !saved.version.auto));
    assert_eq!(listed(&fakes, &ids["board"]), ["c", "a"]);
}

#[test]
fn a_batch_naming_a_document_the_workspace_does_not_hold_saves_nothing() {
    let (fakes, ids) = fakes(MemoryVersionStore::new());
    let nothing = serde_json::Value::from("01BX5ZZKBKACTAV9WEVGEMMVRZ");
    let refused = block_on(VersionSave::execute(&fakes, input(&[&ids["plan"], &nothing], "never")));
    let document_id = nothing.as_str().expect("an id").to_owned();
    assert_eq!(refused, Err(Refusal::DocumentNotFound { document_id, workspace_id: W.to_owned() }));
    assert!(listed(&fakes, &ids["plan"]).is_empty());
}

#[test]
fn a_store_that_refuses_part_way_keeps_what_it_saved_before() {
    let (_, ids) = fakes(MemoryVersionStore::new());
    let plan = ids["plan"].as_str().expect("an id");
    let kept = SavedVersion {
        id: "kept".to_owned(),
        created_at: "2026-01-01T00:00:00.000Z".to_owned(),
        label: None,
        auto: false,
        operator: None,
        restored_from: None,
    };
    let versions = MemoryVersionStore::new().holding(W, plan, vec![kept]).keeping_at_most(1);
    let (fakes, ids) = fakes(versions);
    let refused =
        block_on(VersionSave::execute(&fakes, input(&[&ids["board"], &ids["plan"]], "l")));
    assert_eq!(refused, Err(Refusal::TooManyVersions { limit: 1 }));
    assert_eq!(listed(&fakes, &ids["board"]), ["version-1"]);
    assert_eq!(listed(&fakes, &ids["plan"]), ["kept"]);
}

#[test]
fn a_store_that_cannot_save_is_answered_with_its_failure() {
    let (fakes, ids) = fakes(MemoryVersionStore::failing(PortError::DatabaseBusy));
    let refused = block_on(VersionSave::execute(&fakes, input(&[&ids["plan"]], "l")));
    assert_eq!(refused, Err(Refusal::DatabaseBusy));
}

#[test]
fn a_workspace_the_store_holds_no_record_of_is_refused() {
    let fakes = Fakes {
        records: MemoryRecordStore::new(),
        versions: MemoryVersionStore::new(),
        lock: KeyedLock::new(),
    };
    let refused =
        block_on(VersionSave::execute(&fakes, input(&[&"01BX5ZZKBKACTAV9WEVGEMMVRZ".into()], "l")));
    let workspace_id = W.to_owned();
    assert_eq!(refused, Err(Refusal::from(&PortError::WorkspaceNotFound { workspace_id })));
}

#[test]
fn a_save_waits_for_the_workspace_write_lock_and_holds_it_until_done() {
    let (fakes, ids) = fakes(MemoryVersionStore::new());
    let held = block_on(fakes.lock.lock(W));
    let mut context = Context::from_waker(Waker::noop());
    let mut save = pin!(VersionSave::execute(&fakes, input(&[&ids["plan"]], "l")));
    assert!(save.as_mut().poll(&mut context).is_pending(), "a save while another holds the lock");
    assert!(listed(&fakes, &ids["plan"]).is_empty());
    drop(held);
    let Poll::Ready(saved) = save.as_mut().poll(&mut context) else {
        panic!("the save goes on once the lock is let go");
    };
    assert_eq!(saved.expect("a save").saved.len(), 1);
    // Released: another key and this one are free again.
    drop(block_on(fakes.lock.lock(W)));
}
