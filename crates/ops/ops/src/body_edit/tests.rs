//! What the recording cannot show of a body edit: a keeper that cannot keep
//! the write, an edit that moves nothing, a document the sync declines, and
//! the ceiling on open changes met through the whole call.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ExportMode, LoroList, TreeID, import_bytes};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_port_fakes::{
    FixedCaller, FixedClock, KeyedLock, MemoryRecordStore, MemoryRegistry, MemoryVersionStore,
    RecordingNotifier, RecordingObserver, SeqIdMint, block_on,
};
use whiteboard_workspace_index::WorkspaceRecord;

// Marked as test code where it is, so repro-check's scan for what production
// embeds does not read the recording as an input of the shipped build.
#[cfg(test)]
const CASES: &str =
    include_str!("../../../../../packages/mcp-server/src/server/mcp/oracle/body-edit.jsonl");
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
        unreachable!("the address was resolved before the write")
    }

    fn caller(&self) -> &FixedCaller {
        unreachable!("the address was resolved before the write")
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
fn id(name: &str) -> String {
    record()["ids"][name].as_str().expect("an id").to_owned()
}

#[cfg(test)]
fn snapshot() -> Vec<u8> {
    base64_to_bytes(record()["snapshot"].as_str().expect("base64")).expect("base64")
}

#[cfg(test)]
fn merging(record: &[u8], update: &[u8]) -> Result<Vec<u8>, String> {
    let doc = import_bytes(record).map_err(|e| e.0)?;
    doc.import(update).map_err(|e| e.to_string())?;
    doc.export(ExportMode::Snapshot).map_err(|e| e.to_string())
}

#[cfg(test)]
fn refusing(_: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
    Err("full".to_owned())
}

#[cfg(test)]
fn fakes(records: MemoryRecordStore) -> Fakes {
    Fakes {
        records,
        versions: MemoryVersionStore::new(),
        lock: KeyedLock::new(),
        clock: FixedClock::new(1_795_521_600_000.0),
        mint: SeqIdMint::one_peer(7),
        notifier: RecordingNotifier::new(),
        observer: RecordingObserver::new(),
    }
}

/// The body of `list` in the recording.
#[cfg(test)]
const NOTE: &str = "alpha beta gamma delta\n";

#[cfg(test)]
fn run(fakes: &Fakes, input: BodyEditInput) -> Result<BodyEditAnswer, Refusal> {
    block_on(BodyEdit::execute(fakes, input))
}

#[cfg(test)]
fn on(document: &str, exact: &str, text: &str, mode: BodyEditMode) -> BodyEditInput {
    asking(document, (NOTE, exact), text, mode)
}

/// A call replacing the first `exact` of `body`, which the document holds.
#[cfg(test)]
fn asking(
    document: &str,
    (body, exact): (&str, &str),
    text: &str,
    mode: BodyEditMode,
) -> BodyEditInput {
    let start = body.find(exact).and_then(|n| u32::try_from(n).ok()).map_or(0.0, f64::from);
    let width = f64::from(u32::try_from(exact.len()).unwrap_or(0));
    BodyEditInput {
        workspace_id: W.to_owned(),
        document_id: id(document),
        mode: Some(mode),
        proposal_id: None,
        author: None,
        ops: vec![BodyReplace {
            id: "c1".to_owned(),
            node_id: None,
            prefix: None,
            exact: exact.to_owned(),
            suffix: None,
            start,
            end: start + width,
            text: text.to_owned(),
            assumed: exact.to_owned(),
        }],
    }
}

/// Nothing was kept: no update reached the store, and the record reads back as
/// it was held. Silence from the observer alone would not show it, since a
/// write can be appended without being announced.
#[cfg(test)]
fn kept_nothing(fakes: &Fakes, held: &[u8]) {
    assert!(fakes.records.appended(W).is_empty(), "no update reached the store");
    let stored = block_on(fakes.records.load(W)).expect("a load").expect("a record");
    assert_eq!(stored, held, "the stored record is unchanged");
}

#[test]
fn a_keeper_that_cannot_keep_the_write_refuses_and_announces_nothing() {
    let fakes = fakes(MemoryRecordStore::new().merging_with(refusing).holding(W, snapshot()));
    let refusal = run(&fakes, on("list", "alpha", "A", BodyEditMode::Apply)).expect_err("refused");
    assert_eq!(refusal.code(), "corrupt_stored_data");
    assert!(fakes.observer.take().is_empty());
    kept_nothing(&fakes, &snapshot());
}

#[test]
fn an_edit_that_moves_nothing_is_announced_and_keeps_nothing() {
    let fakes = fakes(MemoryRecordStore::new().merging_with(refusing).holding(W, snapshot()));
    let same = on("list", "alpha", "alpha", BodyEditMode::Apply);
    let answer = run(&fakes, same).expect("an answer");
    let BodyEditAnswer::Edited(output) = answer else { panic!("answered") };
    assert_eq!(output.applied, 1);
    assert_eq!(output.body, NOTE);
    assert_eq!(fakes.observer.take().len(), 1, "the write was announced, as the keeper does");
}

/// The record with a list root added to the document `name`, which no writer
/// of the model makes.
#[cfg(test)]
fn snapshot_with_a_list_root(name: &str) -> Vec<u8> {
    let opened = WorkspaceRecord::open_as(&snapshot(), 9).expect("a record");
    let node = opened.document_node(&id(name)).expect("a node").id;
    let tree_id = TreeID::try_from(node.to_string().as_str()).expect("a tree id");
    let meta = opened.doc().get_tree("tree").get_meta(tree_id).expect("a meta map");
    meta.insert_container("noise", LoroList::new()).expect("a list");
    opened.doc().commit();
    opened.doc().export(ExportMode::Snapshot).expect("a snapshot")
}

#[test]
fn a_document_the_sync_declines_is_left_pending_and_keeps_nothing() {
    let held = snapshot_with_a_list_root("list");
    let fakes = fakes(MemoryRecordStore::new().merging_with(merging).holding(W, held.clone()));
    for mode in [BodyEditMode::Apply, BodyEditMode::Propose] {
        let answer = run(&fakes, on("list", "alpha", "A", mode)).expect("an answer");
        assert_eq!(answer, BodyEditAnswer::Pending(BodyEditPending::Declined));
        kept_nothing(&fakes, &held);
    }
    assert!(fakes.observer.take().is_empty());
}

/// The record with `count` open changes under one proposal of `draft`.
#[cfg(test)]
fn snapshot_holding_open_changes(count: usize) -> Vec<u8> {
    let opened = WorkspaceRecord::open_as(&snapshot(), 9).expect("a record");
    let text = |value: &str| Value::String(value.to_owned());
    let changes = (0..count)
        .map(|at| {
            let anchor = Value::Map(vec![
                ("kind".to_owned(), text("text")),
                ("quote".to_owned(), Value::Map(vec![("exact".to_owned(), text("x"))])),
                ("start".to_owned(), Value::Number(0.0)),
                ("end".to_owned(), Value::Number(1.0)),
            ]);
            Value::Map(vec![
                ("id".to_owned(), text(&format!("h{at}"))),
                ("status".to_owned(), text("open")),
                ("op".to_owned(), text("body.replace")),
                ("anchor".to_owned(), anchor),
                ("text".to_owned(), text("y")),
                ("assumed".to_owned(), text("x")),
            ])
        })
        .collect();
    let proposal = Value::Map(vec![
        ("id".to_owned(), text("held")),
        ("createdAt".to_owned(), text("2026-11-24T12:00:00.000Z")),
        ("changes".to_owned(), Value::Seq(changes)),
    ]);
    let write = Write {
        op: WriterName::WriteProposal,
        args: Value::Map(vec![("proposal".to_owned(), proposal)]),
    };
    save_batch(&opened, 9, 1.0, &id("draft"), &[write]).expect("saved");
    opened.doc().export(ExportMode::Snapshot).expect("a snapshot")
}

#[test]
fn a_proposal_past_the_ceiling_is_refused_through_the_whole_call_and_writes_nothing() {
    let limit =
        "the limit of 1000 open proposed changes for one document; adopt or dismiss some first";
    let held = snapshot_holding_open_changes(1000);
    let fakes = fakes(MemoryRecordStore::new().merging_with(merging).holding(W, held.clone()));
    let draft = "Intro line. The plan is simple. Outro line.\n";
    let mut input = asking("draft", (draft, "Intro"), "Start", BodyEditMode::Propose);
    let refusal = run(&fakes, input.clone()).expect_err("refused");
    assert_eq!(refusal, Refusal::OpenChangesCeiling { open: 1001, limit: limit.to_owned() });
    assert!(fakes.observer.take().is_empty(), "nothing was kept, so nothing is announced");
    kept_nothing(&fakes, &held);
    input.mode = Some(BodyEditMode::Apply);
    assert!(matches!(run(&fakes, input), Ok(BodyEditAnswer::Edited(_))), "applying adds no change");
}
