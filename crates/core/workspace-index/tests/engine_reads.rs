//! The engine's reads over a workspace record the recording does not hold: a
//! record with pins, a trash, a compaction stamp, a shadowed path, an unreadable
//! node and a document hosted with marks. Every expectation is what the
//! TypeScript's readers answer for the same record, built the same way.

#[cfg(test)]
#[path = "../../crdt/tests/support/mod.rs"]
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the shared helpers are each used by some of the recordings' tests"
    )
)]
mod support;

use serde_json::{Value as Json, json};
use support::{assert_same, model_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{
    ExpandType, LoroDoc, LoroMap, LoroMovableList, LoroText, LoroValue, StyleConfig,
    StyleConfigMap, TreeID, set_peer_id,
};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName};
use whiteboard_workspace_index::answer_workspace_query;

const A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const B: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
const C: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAC";

#[cfg(test)]
fn node(doc: &LoroDoc, parent: Option<TreeID>, meta: &[(&str, LoroValue)]) -> (TreeID, LoroMap) {
    let tree = doc.get_tree("tree");
    let id = tree.create(parent).expect("a node");
    let data = tree.get_meta(id).expect("meta");
    for (key, value) in meta {
        data.insert(key, value.clone()).expect("a scalar");
    }
    (id, data)
}

#[cfg(test)]
fn text(value: &str) -> LoroValue {
    LoroValue::from(value)
}

#[cfg(test)]
fn document(doc: &LoroDoc, parent: Option<TreeID>, id: &str, segment: &str, kind: &str) -> LoroMap {
    let meta = [("documentId", text(id)), ("segment", text(segment)), ("kind", text(kind))];
    node(doc, parent, &meta).1
}

#[cfg(test)]
fn blob(digit: &str) -> LoroValue {
    LoroValue::Map(
        [
            ("algorithm".to_owned(), text("sha-256")),
            ("digestHex".to_owned(), text(&digit.repeat(64))),
        ]
        .into_iter()
        .collect(),
    )
}

#[cfg(test)]
fn row(entries: Vec<(&str, LoroValue)>) -> LoroValue {
    LoroValue::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

/// A record holding a folder with a marked markdown document, a canvas and a
/// markdown document sharing a path, a node no reader reads, and the workspace's
/// own pins, compaction stamp and trash.
#[cfg(test)]
fn record() -> LoroDoc {
    let doc = LoroDoc::new();
    set_peer_id_of(&doc);
    let mut styles = StyleConfigMap::new();
    styles.insert("bold".into(), StyleConfig { expand: ExpandType::After });
    doc.config_text_style(styles);
    let (folder, _) = node(&doc, None, &[("segment", text("f")), ("name", text("Folder F"))]);
    let named = [
        ("documentId", text(A)),
        ("segment", text("a")),
        ("kind", text("markdown")),
        ("name", text("Doc A")),
        ("nameChosen", LoroValue::Bool(true)),
        ("createdAt", LoroValue::I64(1)),
        ("updatedAt", LoroValue::I64(2)),
    ];
    let (_, held) = node(&doc, Some(folder), &named);
    let body = held.insert_container("body", LoroText::new()).expect("a body");
    body.insert(0, "hello").expect("text");
    body.mark(0..2, "bold", true).expect("a mark");
    let locks = held.insert_container("nodeLocks", LoroMap::new()).expect("locks");
    locks.insert("n1", true).expect("a lock");
    let plane = held.insert_container("plane:x", LoroMap::new()).expect("a plane");
    plane.insert("k", "v").expect("an entry");
    let canvas = document(&doc, None, B, "dup", "spatial");
    let nodes = canvas.insert_container("nodes", LoroMap::new()).expect("nodes");
    let one = row(vec![
        ("id", text("n1")),
        ("x", 1.into()),
        ("y", 2.into()),
        ("width", 3.into()),
        ("height", 4.into()),
    ]);
    nodes.insert("n1", one).expect("a node");
    document(&doc, None, C, "dup", "markdown");
    let unreadable =
        [("segment", text("x")), ("kind", text("weird")), ("documentId", text("nope"))];
    let (bad, _) = node(&doc, None, &unreadable);
    node(&doc, Some(bad), &[("segment", text("below"))]);
    let meta = doc.get_map("workspaceMeta");
    meta.insert("lastCompactedAt", 1_700_000_000_000_i64).expect("a stamp");
    let pinned = meta.insert_container("pinned", LoroMovableList::new()).expect("pins");
    for id in [B, "gone", A] {
        pinned.push(id).expect("a pin");
    }
    let trash = doc.get_map("trash");
    let gone = row(vec![
        ("documentId", text(B)),
        ("path", text("old/b")),
        ("deletedAt", 5.into()),
        ("blob", blob("a")),
    ]);
    let folders = LoroValue::from(vec![row(vec![("path", text("old")), ("name", text("Old"))])]);
    let newer = row(vec![
        ("documentId", text(C)),
        ("path", text("old/c")),
        ("name", text("Doc C")),
        ("deletedAt", 9.into()),
        ("blob", blob("b")),
        ("folderNames", folders),
    ]);
    trash.insert(B, gone).expect("a row");
    trash.insert(C, newer).expect("a row");
    trash.insert("damaged", row(vec![("documentId", text("damaged"))])).expect("a row");
    doc.commit();
    doc
}

#[cfg(test)]
fn set_peer_id_of(doc: &LoroDoc) {
    set_peer_id(doc, 7).expect("a peer");
}

#[cfg(test)]
fn answer(doc: &LoroDoc, name: QueryName, args: &[(&str, &str)]) -> Value {
    let args = (!args.is_empty()).then(|| {
        Value::Map(
            args.iter().map(|(k, v)| ((*k).to_owned(), Value::String((*v).to_owned()))).collect(),
        )
    });
    let query = Query { query: name, args };
    answer_workspace_query(doc, &query).expect("answered").value
}

#[cfg(test)]
fn assert_answers(doc: &LoroDoc, name: QueryName, args: &[(&str, &str)], expected: &Json) {
    assert_same(
        &format!("{name:?}"),
        &answer(doc, name, args),
        &model_of(&json!({ "ok": expected })),
    );
}

#[cfg(test)]
fn assert_refuses(doc: &LoroDoc, name: QueryName, args: &[(&str, &str)], class: &str) {
    assert_same(
        &format!("{name:?}"),
        &answer(doc, name, args),
        &model_of(&json!({ "err": class })),
    );
}

#[test]
fn the_documents_are_listed_in_tree_order_with_a_shadowed_path_marked() {
    let expected = json!([
        { "documentId": A, "segment": "a", "kind": "markdown", "name": "Doc A", "nameChosen": true,
          "createdAt": 1, "updatedAt": 2, "path": "f/a", "contentDigest": "da3c375a83b8d6fb" },
        { "documentId": B, "segment": "dup", "kind": "spatial", "path": "dup",
          "contentDigest": "c11a7c5986fdd939" },
        { "documentId": C, "segment": "dup", "kind": "markdown", "path": "dup",
          "contentDigest": "f6bbc27f5a56d1e7", "shadowed": true },
    ]);
    assert_answers(&record(), QueryName::Documents, &[], &expected);
}

#[test]
fn the_nodes_are_every_readable_folder_and_document_with_its_path() {
    let expected = json!([
        { "type": "folder", "segment": "f", "name": "Folder F", "path": "f" },
        { "type": "document", "path": "f/a", "meta": { "documentId": A, "segment": "a",
          "kind": "markdown", "name": "Doc A", "nameChosen": true, "createdAt": 1, "updatedAt": 2 } },
        { "type": "document", "path": "dup",
          "meta": { "documentId": B, "segment": "dup", "kind": "spatial" } },
        { "type": "document", "path": "dup",
          "meta": { "documentId": C, "segment": "dup", "kind": "markdown" } },
    ]);
    assert_answers(&record(), QueryName::Nodes, &[], &expected);
}

#[test]
fn a_node_no_reader_reads_is_named_by_its_tree_id_and_its_children_are_not() {
    assert_answers(&record(), QueryName::UnreadableNodes, &[], &json!(["33@7"]));
}

#[test]
fn the_workspace_keeps_its_stamp_its_pins_its_folder_names_and_its_newest_trash_first() {
    let doc = record();
    assert_answers(
        &doc,
        QueryName::Meta,
        &[],
        &json!({ "lastCompactedAt": 1_700_000_000_000_i64 }),
    );
    assert_answers(&doc, QueryName::Pinned, &[], &json!([B, "gone", A]));
    assert_answers(
        &doc,
        QueryName::FolderNames,
        &[],
        &json!([{ "path": "f", "name": "Folder F" }]),
    );
    let digest = |digit: &str| digit.repeat(64);
    let expected = json!([
        { "documentId": C, "path": "old/c", "name": "Doc C", "deletedAt": 9,
          "folderNames": [{ "path": "old", "name": "Old" }],
          "blob": { "algorithm": "sha-256", "digestHex": digest("b") } },
        { "documentId": B, "path": "old/b", "deletedAt": 5,
          "blob": { "algorithm": "sha-256", "digestHex": digest("a") } },
    ]);
    assert_answers(&doc, QueryName::Trash, &[], &expected);
}

#[test]
fn a_record_that_holds_none_of_it_answers_empty() {
    let doc = LoroDoc::new();
    for name in [QueryName::Documents, QueryName::Nodes, QueryName::Pinned, QueryName::Trash] {
        assert_answers(&doc, name, &[], &json!([]));
    }
    assert_answers(&doc, QueryName::FolderNames, &[], &json!([]));
    assert_answers(&doc, QueryName::UnreadableNodes, &[], &json!([]));
    assert_answers(&doc, QueryName::Meta, &[], &json!({}));
    assert_eq!(doc.get_value(), LoroDoc::new().get_value(), "no read registers a root");
}

#[test]
fn a_stamp_that_is_not_an_integer_is_not_a_stamp() {
    let doc = LoroDoc::new();
    doc.get_map("workspaceMeta").insert("lastCompactedAt", 1.5).expect("a stamp");
    assert_answers(&doc, QueryName::Meta, &[], &json!({}));
}

#[test]
fn a_document_hosted_on_a_node_is_read_as_a_document_of_its_own() {
    let doc = record();
    let marked = json!([{ "insert": "he", "attributes": { "bold": true } }, { "insert": "llo" }]);
    assert_answers(&doc, QueryName::BodyDelta, &[("documentId", A)], &marked);
    assert_answers(&doc, QueryName::NodeLocks, &[("documentId", A)], &json!(["n1"]));
    let canvas = json!({ "canvas": { "nodes": [{ "id": "n1", "x": 1, "y": 2, "width": 3, "height": 4 }],
        "edges": [] }, "skipped": 0 });
    assert_answers(&doc, QueryName::SpatialCanvas, &[("documentId", B)], &canvas);
    assert_answers(
        &doc,
        QueryName::DocumentKind,
        &[("documentId", B)],
        &json!({ "$undefined": true }),
    );
    let asked = [("documentId", C), ("kind", "markdown")];
    assert_answers(
        &doc,
        QueryName::DocumentContent,
        &asked,
        &json!({ "kind": "markdown", "body": "" }),
    );
}

#[test]
fn a_hosted_document_has_its_own_size_and_digest_and_none_of_the_records() {
    let doc = record();
    assert_answers(&doc, QueryName::StateSize, &[("documentId", A)], &json!(8));
    assert_answers(
        &doc,
        QueryName::ContentDigest,
        &[("documentId", A)],
        &json!("da3c375a83b8d6fb"),
    );
}

#[test]
fn a_document_the_record_does_not_hold_is_refused_as_the_typescript_refuses_it() {
    let doc = record();
    assert_refuses(&doc, QueryName::DocumentKind, &[("documentId", "zzz")], "Error");
    assert_refuses(&doc, QueryName::StateSize, &[("documentId", "zzz")], "RangeError");
    assert_refuses(&doc, QueryName::ContentDigest, &[("documentId", "zzz")], "RangeError");
}

#[test]
fn a_query_that_names_what_the_record_does_not_read_is_left_to_the_caller() {
    let doc = record();
    let answered =
        |name, args: Option<Value>| answer_workspace_query(&doc, &Query { query: name, args });
    let since = Some(Value::Map(vec![("since".into(), Value::Seq(Vec::new()))]));
    assert!(answered(QueryName::Documents, since).is_none());
    assert!(answered(QueryName::Documents, Some(Value::Map(Vec::new()))).is_some());
    assert!(answered(QueryName::Documents, Some(Value::Null)).is_none());
    assert!(answered(QueryName::TouchedSince, None).is_none());
    assert!(
        answered(QueryName::DocumentKind, None).is_none(),
        "a document of its own is the engine's"
    );
    let hosted = Some(Value::Map(vec![("documentId".into(), Value::String(A.into()))]));
    assert!(answered(QueryName::Documents, hosted).is_none(), "a listing is not hosted");
}

/// The ids a document gets: canonical ULIDs differing in their last digits.
#[cfg(test)]
fn id_at(n: usize) -> String {
    format!("01ARZ3NDEKTSV4RRFF{n:08}")
}

#[test]
fn the_listing_holds_each_document_once_and_marks_every_one_that_repeats_a_path() {
    use whiteboard_proptest::proptest::prelude::{prop, prop_assert_eq};
    use whiteboard_proptest::{Floor, check};
    let repeating = Floor::new("a record where some path is held by two documents");
    check(prop::collection::vec(0_u8..4, 0..10), None, |segments| {
        let doc = LoroDoc::new();
        for (n, segment) in segments.iter().enumerate() {
            document(&doc, None, &id_at(n), &format!("s{segment}"), "markdown");
        }
        let Value::Map(answered) = answer(&doc, QueryName::Documents, &[]) else { unreachable!() };
        let Some((_, Value::Seq(listed))) = answered.into_iter().find(|(key, _)| key == "ok")
        else {
            unreachable!()
        };
        let shadowed = listed
            .iter()
            .filter(|entry| matches!(entry, Value::Map(fields) if fields.iter().any(|(k, _)| k == "shadowed")))
            .count();
        let distinct = segments.iter().collect::<std::collections::BTreeSet<_>>().len();
        repeating.draw(distinct < segments.len());
        prop_assert_eq!(listed.len(), segments.len());
        prop_assert_eq!(shadowed, segments.len() - distinct);
        Ok(())
    });
    repeating.assert(40);
}
