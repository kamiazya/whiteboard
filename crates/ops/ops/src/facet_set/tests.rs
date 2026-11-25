//! What the recording cannot show of a facet write: a document with no
//! frontmatter to tag, a keeper that keeps part of a batch, and the writes
//! this crate leaves pending.

use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ExportMode, Fault, MoreWriters, import_bytes};
use whiteboard_model::Value;
use whiteboard_model::crdt::WriterName;
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_port_fakes::{
    FixedCaller, FixedClock, KeyedLock, MemoryRecordStore, MemoryRegistry, MemoryVersionStore,
    RecordingNotifier, RecordingObserver, SeqIdMint, block_on,
};
use whiteboard_workspace_index::WorkspaceWriters;

// Marked as test code where it is, so repro-check's scan for what production
// embeds does not read the recording as an input of the shipped build.
#[cfg(test)]
const CASES: &str =
    include_str!("../../../../../packages/mcp-server/src/server/mcp/oracle/facet-set.jsonl");
const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
/// A document the record holds a node for and no content.
const BARE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

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

/// The recorded record with one more document: a markdown node that holds no
/// content, so no frontmatter.
#[cfg(test)]
fn snapshot_with_a_bare_document() -> Vec<u8> {
    let held = base64_to_bytes(record()["snapshot"].as_str().expect("base64")).expect("base64");
    let opened = WorkspaceRecord::open_as(&held, 9).expect("a record");
    let args = Value::Map(vec![
        ("path".to_owned(), Value::String("bare".to_owned())),
        ("documentId".to_owned(), Value::String(BARE.to_owned())),
        ("kind".to_owned(), Value::String("markdown".to_owned())),
    ]);
    let step = WorkspaceWriters { now_ms: 1.0 }.apply(
        opened.doc(),
        WriterName::CreateWorkspaceDocumentAtPath,
        &args,
    );
    assert!(matches!(step, Some(Ok(()) | Err(Fault::Declined))), "{step:?}");
    opened.doc().commit();
    opened.doc().export(ExportMode::Snapshot).expect("a snapshot")
}

#[cfg(test)]
fn fakes(records: MemoryRecordStore) -> Fakes {
    Fakes {
        records: records.holding(W, snapshot_with_a_bare_document()),
        versions: MemoryVersionStore::new(),
        lock: KeyedLock::new(),
        clock: FixedClock::new(1_795_521_600_000.0),
        mint: SeqIdMint::one_peer(7),
        notifier: RecordingNotifier::new(),
        observer: RecordingObserver::new(),
    }
}

/// A store that keeps a write by merging it, as the keeper does.
#[cfg(test)]
fn merging(record: &[u8], update: &[u8]) -> Result<Vec<u8>, String> {
    let doc = import_bytes(record).map_err(|e| e.0)?;
    doc.import(update).map_err(|e| e.to_string())?;
    doc.export(ExportMode::Snapshot).map_err(|e| e.to_string())
}

/// The writes a keeper has kept so far.
#[cfg(test)]
static KEPT: AtomicUsize = AtomicUsize::new(0);

/// A keeper with room for one write.
#[cfg(test)]
fn keeping_one(record: &[u8], update: &[u8]) -> Result<Vec<u8>, String> {
    match KEPT.fetch_add(1, Ordering::SeqCst) {
        0 => merging(record, update),
        _ => Err("full".to_owned()),
    }
}

#[cfg(test)]
fn tagging(document_ids: &[String]) -> FacetSetInput {
    FacetSetInput {
        workspace_id: W.to_owned(),
        document_ids: document_ids.to_vec(),
        node_id: None,
        edge_id: None,
        tags: Some(TagChange { add: vec!["fresh".to_owned()], ..TagChange::default() }),
        target: None,
        facets: None,
    }
}

#[cfg(test)]
fn run(fakes: &Fakes, input: FacetSetInput) -> Result<FacetSetAnswer, Refusal> {
    block_on(FacetSet::execute(fakes, input))
}

#[test]
fn a_document_with_no_frontmatter_is_told_where_a_tag_would_go() {
    let fakes = fakes(MemoryRecordStore::new().merging_with(merging));
    let refusal = run(&fakes, tagging(&[BARE.to_owned()])).expect_err("a refusal");
    assert_eq!(refusal, Refusal::DocumentHasNoFrontmatter { document_id: BARE.to_owned() });
    assert!(fakes.observer.take().is_empty(), "nothing was kept, so nothing is announced");
}

#[test]
fn a_refusal_part_way_keeps_the_documents_written_before_it() {
    let fakes = fakes(MemoryRecordStore::new().merging_with(merging));
    let note = id("note");
    let refusal = run(&fakes, tagging(&[note.clone(), BARE.to_owned()])).expect_err("a refusal");
    assert_eq!(refusal, Refusal::DocumentHasNoFrontmatter { document_id: BARE.to_owned() });
    let told: Vec<String> = fakes.observer.take().into_iter().map(|w| w.document_id).collect();
    assert_eq!(told, std::slice::from_ref(&note), "the first document landed and was announced");
    let again = run(&fakes, tagging(&[note])).expect("an answer");
    let FacetSetAnswer::Updated(output) = again else { panic!("answered") };
    let tags = output.updated.first().and_then(|doc| doc.tags.clone()).unwrap_or_default();
    assert_eq!(tags.iter().filter(|tag| *tag == "fresh").count(), 1, "kept once: {tags:?}");
}

#[test]
fn a_keeper_that_cannot_keep_a_document_stops_the_batch_there() {
    KEPT.store(0, Ordering::SeqCst);
    let fakes = fakes(MemoryRecordStore::new().merging_with(keeping_one));
    let (note, second) = (id("note"), id("second"));
    let refusal = run(&fakes, tagging(&[note.clone(), second])).expect_err("a refusal");
    assert_eq!(refusal.code(), "corrupt_stored_data");
    let told: Vec<String> = fakes.observer.take().into_iter().map(|w| w.document_id).collect();
    assert_eq!(told, [note], "only the document the keeper kept is announced");
}

#[test]
fn a_write_that_moves_two_roots_is_left_pending_and_keeps_nothing() {
    let fakes = fakes(MemoryRecordStore::new().merging_with(merging));
    let mut input = tagging(&[id("note")]);
    input.facets = Some(vec![("other.both/v0".to_owned(), Value::Number(1.0))]);
    let answer = run(&fakes, input).expect("an answer");
    assert_eq!(answer, FacetSetAnswer::Pending(FacetSetPending::Declined));
    assert!(fakes.observer.take().is_empty());
    assert!(fakes.notifier.take_activity().is_empty());
}

#[test]
fn a_facet_that_takes_a_stencil_is_left_pending_before_anything_is_read() {
    let fakes = fakes(MemoryRecordStore::new());
    let mut input = tagging(&[id("board")]);
    input.tags = None;
    input.node_id = Some("pad".to_owned());
    let payload =
        Value::Map(vec![("stencil".to_owned(), Value::String("visual.datastore".into()))]);
    input.facets = Some(vec![("visual.stencil/v0".to_owned(), payload)]);
    let answer = run(&fakes, input).expect("an answer");
    assert_eq!(answer, FacetSetAnswer::Pending(FacetSetPending::StencilFacet));
}

#[test]
fn a_request_that_is_incoherent_is_refused_before_the_record_is_read() {
    let fakes = fakes(MemoryRecordStore::new());
    let none = FacetSetInput { tags: None, ..tagging(&[id("note")]) };
    assert_eq!(run(&fakes, none).expect_err("refused"), Refusal::FacetSetNeedsPayload);
    let both = FacetSetInput {
        node_id: Some("a".into()),
        edge_id: Some("b".into()),
        ..tagging(&[id("board")])
    };
    assert_eq!(run(&fakes, both).expect_err("refused"), Refusal::NodeAndEdgeTarget);
    let many = FacetSetInput { node_id: Some("a".into()), ..tagging(&[id("board"), id("empty")]) };
    assert_eq!(
        run(&fakes, many).expect_err("refused"),
        Refusal::NodeTargetNeedsOneDocument { count: 2 }
    );
    let canvas = FacetSetInput {
        edge_id: Some("a".into()),
        target: Some(FacetTarget::Canvas),
        ..tagging(&[id("board")])
    };
    assert_eq!(run(&fakes, canvas).expect_err("refused"), Refusal::NodeAndCanvasTarget);
}

#[test]
fn which_site_a_write_lands_on_follows_the_element_then_the_target_then_the_kind() {
    let input = |node: bool, edge: bool, target: Option<FacetTarget>| FacetSetInput {
        node_id: node.then(|| "n".to_owned()),
        edge_id: edge.then(|| "e".to_owned()),
        target,
        ..tagging(&[])
    };
    assert!(site_of(&input(true, false, None), None) == Site::Node);
    assert!(site_of(&input(false, true, None), Some(Kind::Spatial)) == Site::Edge);
    assert!(site_of(&input(false, false, Some(FacetTarget::Canvas)), None) == Site::Canvas);
    assert!(site_of(&input(false, false, None), Some(Kind::Spatial)) == Site::Canvas);
    assert!(site_of(&input(false, false, None), Some(Kind::Markdown)) == Site::Document);
    assert!(site_of(&input(false, false, None), None) == Site::Document);
    assert_eq!(required_target(&input(true, false, None)), FacetTarget::Node);
    assert_eq!(required_target(&input(false, true, None)), FacetTarget::Edge);
    assert_eq!(
        required_target(&input(false, false, Some(FacetTarget::Canvas))),
        FacetTarget::Canvas
    );
    assert_eq!(required_target(&input(false, false, None)), FacetTarget::Document);
}

/// The record with `core` of `document_id` rewritten to carry `tags`, as a
/// keeper holding a set stored before the bound would.
#[cfg(test)]
fn snapshot_with_stored_tags(document_id: &str, tags: Vec<String>) -> Vec<u8> {
    let held = base64_to_bytes(record()["snapshot"].as_str().expect("base64")).expect("base64");
    let opened = WorkspaceRecord::open_as(&held, 9).expect("a record");
    let doc = Doc { record: &opened, id: document_id };
    let core = doc.core().ok().flatten().expect("frontmatter");
    let mut next: Map = core.iter().filter(|(key, _)| key != "tags").cloned().collect();
    next.push(("tags".to_owned(), Value::Seq(tags.into_iter().map(Value::String).collect())));
    let args = Value::Map(vec![
        ("documentId".to_owned(), Value::String(document_id.to_owned())),
        ("prev".to_owned(), Value::Map(core)),
        ("next".to_owned(), Value::Map(next)),
    ]);
    let step = WorkspaceWriters { now_ms: 1.0 }.apply(
        opened.doc(),
        WriterName::ReconcileCoreFacets,
        &args,
    );
    assert!(matches!(step, Some(Ok(()))), "{step:?}");
    opened.doc().commit();
    opened.doc().export(ExportMode::Snapshot).expect("a snapshot")
}

#[test]
fn a_set_stored_past_the_bound_takes_a_change_that_does_not_grow_it() {
    let stored: Vec<String> = (0..1030).map(|at| format!("t{at}")).collect();
    let mut fakes = fakes(MemoryRecordStore::new().merging_with(merging));
    fakes.records = MemoryRecordStore::new()
        .merging_with(merging)
        .holding(W, snapshot_with_stored_tags(&id("note"), stored));
    let same_size =
        |change: TagChange| FacetSetInput { tags: Some(change), ..tagging(&[id("note")]) };
    let again = TagChange { add: vec!["t1".into()], ..TagChange::default() };
    assert!(matches!(run(&fakes, same_size(again)), Ok(FacetSetAnswer::Updated(_))));
    let swapped =
        TagChange { add: vec!["t1".into()], remove: vec!["t2".into()], ..TagChange::default() };
    assert!(matches!(run(&fakes, same_size(swapped)), Ok(FacetSetAnswer::Updated(_))));
    let grown = TagChange { add: vec!["more".into()], ..TagChange::default() };
    let refusal = run(&fakes, same_size(grown)).expect_err("a refusal");
    assert_eq!(
        refusal,
        Refusal::TooManyTagsOnElement { count: 1030, what: format!("document {}", id("note")) }
    );
}

/// The record with the kind `document_id` states rewritten to `kind`.
#[cfg(test)]
fn snapshot_stating(document_id: &str, kind: &str) -> Vec<u8> {
    let held = base64_to_bytes(record()["snapshot"].as_str().expect("base64")).expect("base64");
    let opened = WorkspaceRecord::open_as(&held, 9).expect("a record");
    let node = opened.document_node(document_id).expect("a node").id;
    let tree_id = whiteboard_crdt::TreeID::try_from(node.to_string().as_str()).expect("a tree id");
    let meta = opened.doc().get_tree("tree").get_meta(tree_id).expect("a meta map");
    let stated = meta.insert_container("document", whiteboard_crdt::LoroMap::new()).expect("a map");
    stated.insert("kind", kind).expect("a kind");
    opened.doc().commit();
    opened.doc().export(ExportMode::Snapshot).expect("a snapshot")
}

#[test]
fn a_kind_this_build_does_not_recognise_is_no_kind() {
    let mut fakes = fakes(MemoryRecordStore::new());
    fakes.records =
        MemoryRecordStore::new().holding(W, snapshot_stating(&id("second"), "from-a-newer-build"));
    let at = FacetSetInput { node_id: Some("pad".to_owned()), ..tagging(&[id("second")]) };
    let refusal = run(&fakes, at).expect_err("a refusal");
    assert_eq!(
        refusal,
        Refusal::NodeNotFound { document_id: id("second"), node_id: "pad".to_owned() },
        "a document stating no kind has no canvas, so no node"
    );
    let at = FacetSetInput { edge_id: Some("pad".to_owned()), ..tagging(&[id("second")]) };
    let refusal = run(&fakes, at).expect_err("a refusal");
    assert_eq!(
        refusal,
        Refusal::EdgeNotFound { document_id: id("second"), edge_id: "pad".to_owned() },
        "a document stating no kind has no canvas, so no edge"
    );
}

#[test]
fn a_document_that_holds_no_content_reports_the_node_missing_not_a_fabricated_kind() {
    let fakes = fakes(MemoryRecordStore::new());
    let at = FacetSetInput { node_id: Some("pad".to_owned()), ..tagging(&[BARE.to_owned()]) };
    let refusal = run(&fakes, at).expect_err("a refusal");
    assert_eq!(
        refusal,
        Refusal::NodeNotFound { document_id: BARE.to_owned(), node_id: "pad".to_owned() }
    );
    let at = FacetSetInput { edge_id: Some("pad".to_owned()), ..tagging(&[BARE.to_owned()]) };
    let refusal = run(&fakes, at).expect_err("a refusal");
    assert_eq!(
        refusal,
        Refusal::EdgeNotFound { document_id: BARE.to_owned(), edge_id: "pad".to_owned() }
    );
}
