//! `whiteboard-crdt`'s writers as a property over runs drawn here: a run of
//! writes naming a document hosted on a workspace tree node leaves that node
//! holding what the same run leaves a document of its own holding, and each
//! write that wrote answers that document as the one it changed.
//!
//! The node starts with none of its content containers, so its writes open
//! them; the document of its own starts empty. Every run opens with a node
//! `keep` written and `gone` written then deleted, and closes with a body and
//! a thread, so every draw holds a write that wrote, a removal, and a write
//! that wrote nothing (deleting `gone` twice), whatever the random writes
//! between do. The expected content is the standalone document's, written by
//! the same writers over their own roots, so it judges the hosting, not them.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{
    ExportMode, LoroDoc, NodeAt, WriteAnswer, Written, commit, create_node, deep_value, open_tree,
    project_node, set_meta, write_batch,
};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert_eq, prop_oneof};
use whiteboard_proptest::{Floor, check};
use whiteboard_workspace_index::{WorkspaceRecord, write_workspace_batch};

const DOCUMENT: &str = "01ARZ3NDEKTSV4RRFFQ69G5F00";
const TREE: &str = "tree";
const IDS: [&str; 3] = ["keep", "gone", "n2"];
const NOW: f64 = 1_700_000_000_000.0;

#[cfg(test)]
fn object(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

#[cfg(test)]
fn text(s: &str) -> Value {
    Value::String(s.to_owned())
}

#[cfg(test)]
fn node(id: &str, x: u8) -> Value {
    let n = |v: f64| Value::Number(v);
    object(vec![
        ("id", text(id)),
        ("x", n(f64::from(x))),
        ("y", n(1.0)),
        ("width", n(10.0)),
        ("height", n(10.0)),
    ])
}

#[cfg(test)]
fn write(op: WriterName, entries: Vec<(&str, Value)>) -> Write {
    Write { op, args: object(entries) }
}

#[cfg(test)]
fn thread(id: &str) -> Value {
    let message = object(vec![("id", text("m")), ("body", text("hi"))]);
    object(vec![
        ("id", text(id)),
        ("anchor", object(vec![("kind", text("document"))])),
        ("status", text("open")),
        ("messages", Value::Seq(vec![message])),
    ])
}

#[cfg(test)]
fn step() -> impl Strategy<Value = Write> {
    let id = || (0..IDS.len()).prop_map(|i| IDS[i]);
    prop_oneof![
        (id(), 0_u8..4)
            .prop_map(|(id, x)| write(WriterName::WriteSpatialNode, vec![("node", node(id, x))])),
        id().prop_map(|id| write(WriterName::DeleteSpatialNode, vec![("id", text(id))])),
        (id(), prop::bool::ANY).prop_map(|(id, locked)| write(
            WriterName::SetNodeLock,
            vec![("id", text(id)), ("locked", Value::Bool(locked)),]
        )),
        "[ab]{0,3}"
            .prop_map(|body| write(WriterName::WriteMarkdownBody, vec![("body", text(&body))])),
        prop::sample::select(vec!["x.y/v1", "z.w/v1"]).prop_map(|key| write(
            WriterName::WriteFacets,
            vec![("facets", object(vec![(key, Value::Number(1.0))]))]
        )),
        id().prop_map(|id| write(WriterName::WriteCommentThread, vec![("thread", thread(id))])),
        (id(), prop::bool::ANY).prop_map(|(id, open)| write(
            WriterName::SetCommentThreadStatus,
            vec![("threadId", text(id)), ("status", text(if open { "open" } else { "resolved" }))]
        )),
    ]
}

/// Every run, its fixed opening and close around the random writes.
#[cfg(test)]
fn run() -> impl Strategy<Value = Vec<Write>> {
    prop::collection::vec(step(), 0..8).prop_map(|middle| {
        let gone = || write(WriterName::DeleteSpatialNode, vec![("id", text("gone"))]);
        let mut all = vec![
            write(WriterName::WriteSpatialNode, vec![("node", node("keep", 0))]),
            write(WriterName::WriteSpatialNode, vec![("node", node("gone", 0))]),
            gone(),
            gone(),
        ];
        all.extend(middle);
        all.push(write(WriterName::WriteMarkdownBody, vec![("body", text("end"))]));
        all.push(write(WriterName::WriteCommentThread, vec![("thread", thread("t"))]));
        all
    })
}

/// A record holding the document as a node with none of its containers.
#[cfg(test)]
fn bare_record() -> Vec<u8> {
    let doc = LoroDoc::new();
    open_tree(&doc, TREE);
    let node = create_node(&doc, TREE, None).expect("a node");
    for (key, value) in [
        ("documentId", text(DOCUMENT)),
        ("segment", text("a")),
        ("kind", text("spatial")),
        ("createdAt", Value::Number(1.0)),
        ("updatedAt", Value::Number(1.0)),
    ] {
        set_meta(&doc, TREE, node, key, &value).expect("a meta key");
    }
    commit(&doc);
    doc.export(ExportMode::Snapshot).expect("a snapshot")
}

#[cfg(test)]
fn snapshot(written: &Written) -> Vec<u8> {
    written.doc.export(ExportMode::Snapshot).expect("a snapshot")
}

/// The content a document holds, its empty containers left out: a root a
/// writer only opened is not content.
#[cfg(test)]
fn content(doc: &LoroDoc) -> Value {
    let Value::Map(roots) = deep_value(doc) else { return Value::Map(Vec::new()) };
    let held = |value: &Value| match value {
        Value::Map(entries) => !entries.is_empty(),
        Value::String(text) => !text.is_empty(),
        _ => true,
    };
    Value::Map(roots.into_iter().filter(|(_, value)| held(value)).collect())
}

#[cfg(test)]
fn hosted_content(record: &[u8]) -> Value {
    let doc = whiteboard_crdt::import_bytes(record).expect("the record");
    let node = WorkspaceRecord::over(&doc).document_node(DOCUMENT).expect("the document").id;
    content(&project_node(NodeAt { doc: &doc, tree: TREE, node }).expect("a projection"))
}

#[test]
fn a_hosted_run_leaves_the_node_holding_what_it_leaves_a_document_of_its_own() {
    let wrote = Floor::new("a run holding a write that wrote");
    let still = Floor::new("a run holding a write that wrote nothing");
    let empty = LoroDoc::new().export(ExportMode::Snapshot).expect("an empty document");
    check(run(), None, |writes| {
        let (mut own, mut record) = (empty.clone(), bare_record());
        let (mut changed, mut unchanged) = (false, false);
        for one in writes {
            let mut hosted = one.clone();
            if let Value::Map(entries) = &mut hosted.args {
                entries.push(("documentId".to_owned(), text(DOCUMENT)));
            }
            let alone = write_batch(&own, 5, &[one], WriteJudge::None).expect("answered");
            let held = write_workspace_batch(&record, 5, &[hosted], WriteJudge::None, NOW)
                .expect("answered");
            let (WriteAnswer::Applied(a), WriteAnswer::Applied(h)) = (&alone.answer, &held.answer)
            else {
                panic!("a write threw: {:?} / {:?}", alone.answer, held.answer);
            };
            let touched = h.local_update.is_some();
            let expected: Vec<String> =
                if touched { vec![DOCUMENT.to_owned()] } else { Vec::new() };
            prop_assert_eq!(&h.changed, &expected);
            changed |= a.local_update.is_some() && touched;
            unchanged |= a.local_update.is_none() && !touched;
            (own, record) = (snapshot(&alone), snapshot(&held));
            let own_doc = whiteboard_crdt::import_bytes(&own).expect("the document");
            prop_assert_eq!(hosted_content(&record), content(&own_doc));
        }
        wrote.draw(changed);
        still.draw(unchanged);
        Ok(())
    });
    wrote.assert(150);
    still.assert(150);
}
