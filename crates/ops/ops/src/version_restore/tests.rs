//! What the recording cannot show of a restore: a subtree whose version
//! carries no workspace, a target the grammar refuses (the binding's input
//! judgement refuses it first), a keeper that cannot keep the write or read
//! its history, and that a restore left pending did nothing.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_port_fakes::{
    FixedCaller, FixedClock, KeyedLock, MemoryRecordStore, MemoryRegistry, MemoryVersionStore,
    RecordingNotifier, RecordingObserver, SeqIdMint, block_on,
};
use whiteboard_ports::{OperatorKind, SavedVersion, VersionOperator};

// Marked as test code where it is, so repro-check's scan for what production
// embeds does not read the recording as an input of the shipped build.
#[cfg(test)]
const CASES: &str =
    include_str!("../../../../../packages/mcp-server/src/server/mcp/oracle/version-restore.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

struct Fakes {
    records: MemoryRecordStore,
    versions: MemoryVersionStore,
    lock: KeyedLock,
    clock: FixedClock,
    mint: SeqIdMint,
    notifier: RecordingNotifier,
    observer: RecordingObserver,
}

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;
    type Lock = KeyedLock;
    type Clock = FixedClock;
    type Mint = SeqIdMint;
    type Notifier = RecordingNotifier;
    type Observer = RecordingObserver;

    fn records(&self) -> &MemoryRecordStore {
        &self.records
    }

    fn registry(&self) -> &MemoryRegistry {
        unreachable!("the address was resolved before the restore")
    }

    fn caller(&self) -> &FixedCaller {
        unreachable!("the address was resolved before the restore")
    }

    fn versions(&self) -> &MemoryVersionStore {
        &self.versions
    }

    fn lock(&self) -> &KeyedLock {
        &self.lock
    }

    fn clock(&self) -> &FixedClock {
        &self.clock
    }

    fn mint(&self) -> &SeqIdMint {
        &self.mint
    }

    fn notifier(&self) -> &RecordingNotifier {
        &self.notifier
    }

    fn observer(&self) -> &RecordingObserver {
        &self.observer
    }
}

#[cfg(test)]
fn record() -> serde_json::Value {
    serde_json::from_str(CASES.lines().next().expect("a record")).expect("JSON")
}

#[cfg(test)]
fn bytes(text: &serde_json::Value) -> Vec<u8> {
    base64_to_bytes(text.as_str().expect("base64")).expect("base64")
}

#[cfg(test)]
fn id(record: &serde_json::Value, group: &str, name: &str) -> String {
    record[group][name].as_str().expect("an id").to_owned()
}

/// A history naming `version_id` as its document's one version.
#[cfg(test)]
fn owning(version_id: &str) -> Vec<SavedVersion> {
    vec![SavedVersion {
        id: version_id.to_owned(),
        created_at: "2026-11-24T12:00:00.000Z".to_owned(),
        label: Some("saved".to_owned()),
        auto: false,
        operator: Some(VersionOperator { kind: OperatorKind::Ai, display_name: None }),
        restored_from: None,
    }]
}

/// The recorded record and `name`'s version, its past checked out, and no
/// workspace held at any version.
#[cfg(test)]
fn fakes(records: MemoryRecordStore, name: &str) -> (Fakes, VersionRestoreInput) {
    let record = record();
    let (document_id, version_id) = (id(&record, "ids", name), id(&record, "versionIds", name));
    let versions = MemoryVersionStore::new()
        .holding(W, &document_id, owning(&version_id))
        .checking_out(W, &version_id, bytes(&record["checkouts"][&version_id]));
    let fakes = Fakes {
        records: records.holding(W, bytes(&record["snapshot"])),
        versions,
        lock: KeyedLock::new(),
        clock: FixedClock::new(1_795_521_600_000.0),
        mint: SeqIdMint::one_peer(7),
        notifier: RecordingNotifier::new(),
        observer: RecordingObserver::new(),
    };
    let input = VersionRestoreInput {
        workspace_id: W.to_owned(),
        document_id,
        version_id,
        target_path: None,
        overwrite: None,
        subtree: None,
    };
    (fakes, input)
}

#[cfg(test)]
fn refused(fakes: &Fakes, input: VersionRestoreInput) -> Refusal {
    block_on(VersionRestore::execute(fakes, input)).expect_err("a refusal")
}

#[test]
fn a_version_id_the_keeper_names_is_safe_characters_up_to_64() {
    assert!(keeper_names("aZ09_-"));
    assert!(keeper_names(&"v".repeat(64)));
    assert!(!keeper_names(&"v".repeat(65)));
    assert!(!keeper_names(""));
    assert!(!keeper_names("a.b"));
    assert!(!keeper_names("a/b"));
}

#[test]
fn a_subtree_whose_version_carries_no_workspace_is_refused() {
    let (fakes, input) = fakes(MemoryRecordStore::new(), "plan");
    let version_id = input.version_id.clone();
    let refusal = refused(&fakes, VersionRestoreInput { subtree: Some(true), ..input });
    assert_eq!(refusal, Refusal::SubtreeNeedsWorkspaceVersion { version_id });
    assert!(fakes.notifier.take_restores().is_empty());
}

#[test]
fn a_target_the_grammar_refuses_is_refused_before_the_mode() {
    let (fakes, input) = fakes(MemoryRecordStore::new(), "plan");
    let asked =
        VersionRestoreInput { target_path: Some("a//b".to_owned()), subtree: Some(true), ..input };
    assert_eq!(
        refused(&fakes, asked),
        Refusal::InvalidRestoreTargetPath { target_path: "a//b".to_owned() }
    );
}

#[test]
fn a_write_the_keeper_cannot_keep_is_refused_and_its_progress_ended() {
    let records = MemoryRecordStore::new().merging_with(|_, _| Err("full".to_owned()));
    let (fakes, input) = fakes(records, "plan");
    let refusal = refused(&fakes, input);
    assert_eq!(refusal.code(), "corrupt_stored_data");
    let phases: Vec<RestorePhase> =
        fakes.notifier.take_restores().into_iter().map(|e| e.phase).collect();
    assert_eq!(phases, [RestorePhase::Started, RestorePhase::Complete]);
    assert!(fakes.observer.take().is_empty(), "nothing kept, nothing announced");
    let history = block_on(fakes.versions.list(W, &id(&record(), "ids", "plan"))).expect("a list");
    assert_eq!(history.len(), 1, "no restore point for a restore that did not land");
}

#[test]
fn a_history_the_keeper_cannot_read_is_refused() {
    let (mut fakes, input) = fakes(MemoryRecordStore::new(), "plan");
    fakes.versions = MemoryVersionStore::failing(PortError::DatabaseBusy);
    assert_eq!(refused(&fakes, input).code(), "database_busy");
}

#[test]
fn a_restore_left_pending_told_nothing_and_kept_nothing() {
    let (fakes, input) = fakes(MemoryRecordStore::new(), "wide");
    let answer = block_on(VersionRestore::execute(&fakes, input)).expect("an answer");
    assert_eq!(answer, VersionRestoreAnswer::Pending(RestorePending::Declined));
    assert!(fakes.notifier.take_restores().is_empty());
    assert!(fakes.observer.take().is_empty());
    assert!(fakes.records.appended(W).is_empty());
}

#[test]
fn a_restore_in_place_keeps_one_update_written_as_the_minted_replica() {
    let (fakes, input) = fakes(MemoryRecordStore::new(), "plan");
    let answer = block_on(VersionRestore::execute(&fakes, input)).expect("an answer");
    assert!(matches!(answer, VersionRestoreAnswer::Restored(_)));
    let appended = fakes.records.appended(W);
    assert_eq!(appended.len(), 1);
    let doc = import_bytes(&bytes(&record()["snapshot"])).expect("the record");
    let before = doc.oplog_vv();
    doc.import(&appended[0]).expect("the update");
    let grown: Vec<u64> = doc
        .oplog_vv()
        .iter()
        .filter(|(peer, counter)| before.get(peer) != Some(counter))
        .map(|(peer, _)| *peer)
        .collect();
    assert_eq!(grown, [7], "only the minted replica wrote");
}
