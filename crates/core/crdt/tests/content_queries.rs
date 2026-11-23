//! The content queries over documents written here, for the arrangements the
//! recording does not hold: each retired shape, the order a lock list and a
//! first retired entry are found in, the values the wire writes as markers.

use loro::{LoroDoc, LoroMap, LoroText, LoroValue, TextDelta};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{
    CONTENT_QUERIES, DocumentKind, Refusal, answer_content_query, document_kind, frontier_pairs,
    markdown_body, retired_stored_shape, version_pairs,
};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName};

#[cfg(test)]
fn ask(doc: &LoroDoc, name: QueryName) -> Value {
    answer_content_query(doc, &Query { query: name, args: None }).expect("answered").value
}

#[cfg(test)]
fn ok_of(doc: &LoroDoc, name: QueryName) -> Value {
    match ask(doc, name) {
        Value::Map(entries) => match entries.as_slice() {
            [(key, value)] if key == "ok" => value.clone(),
            other => panic!("not an ok answer: {other:?}"),
        },
        other => panic!("not an answer: {other:?}"),
    }
}

fn s(text: &str) -> Value {
    Value::String(text.to_owned())
}

fn strings(items: &[&str]) -> Value {
    Value::Seq(items.iter().map(|i| s(i)).collect())
}

#[cfg(test)]
fn set(doc: &LoroDoc, root: &str, key: &str, value: impl Into<LoroValue>) {
    doc.get_map(root).insert(key, value.into()).expect("set");
}

#[cfg(test)]
fn object(entries: &[(&str, LoroValue)]) -> LoroValue {
    LoroValue::Map(
        entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect::<loro::LoroMapValue>(),
    )
}

#[test]
fn a_kind_is_what_the_envelope_states_and_nothing_else_is_one() {
    let doc = LoroDoc::new();
    assert_eq!(document_kind(&doc), None);
    assert_eq!(
        ok_of(&doc, QueryName::DocumentKind),
        Value::Map(vec![("$undefined".into(), Value::Bool(true))])
    );
    set(&doc, "document", "kind", "markdown");
    assert_eq!(document_kind(&doc), Some(DocumentKind::Markdown));
    assert_eq!(ok_of(&doc, QueryName::DocumentKind), s("markdown"));
    set(&doc, "document", "kind", "spatial");
    assert_eq!(document_kind(&doc), Some(DocumentKind::Spatial));
    assert_eq!(ok_of(&doc, QueryName::DocumentKind), s("spatial"));
    set(&doc, "document", "kind", "whiteboard");
    assert_eq!(document_kind(&doc), None);
    set(&doc, "document", "kind", 3_i64);
    assert_eq!(document_kind(&doc), None);
}

#[test]
fn a_kind_held_in_a_container_is_no_kind() {
    let doc = LoroDoc::new();
    let held = doc.get_map("document").insert_container("kind", LoroText::new()).expect("text");
    held.insert(0, "markdown").expect("text");
    assert_eq!(document_kind(&doc), None);
}

#[test]
fn a_body_is_its_text_and_an_empty_one_is_empty() {
    let doc = LoroDoc::new();
    assert_eq!(markdown_body(&doc), Ok(String::new()));
    doc.get_text("body").insert(0, "# Plan 😀").expect("text");
    assert_eq!(markdown_body(&doc), Ok("# Plan 😀".to_owned()));
    assert_eq!(ok_of(&doc, QueryName::MarkdownBody), s("# Plan 😀"));
}

#[test]
fn a_body_stored_as_the_okf_body_node_is_refused_unless_it_holds_text_or_the_document_is_spatial() {
    let doc = LoroDoc::new();
    set(&doc, "nodes", "okf-body", object(&[("x", 1_i64.into())]));
    assert_eq!(markdown_body(&doc), Err(Refusal("RetiredStoredShapeError")));
    assert_eq!(
        retired_stored_shape(&doc).as_deref(),
        Some("a markdown body stored as the `okf-body` canvas text node")
    );
    let refused = ask(&doc, QueryName::MarkdownBody);
    assert_eq!(refused, Value::Map(vec![("err".into(), s("RetiredStoredShapeError"))]));
    set(&doc, "document", "kind", "spatial");
    assert_eq!(markdown_body(&doc), Ok(String::new()));
    assert_eq!(retired_stored_shape(&doc), None);
    set(&doc, "document", "kind", "markdown");
    assert!(markdown_body(&doc).is_err());
    doc.get_text("body").insert(0, "prose").expect("text");
    assert_eq!(markdown_body(&doc), Ok("prose".to_owned()));
    assert_eq!(retired_stored_shape(&doc), None);
}

fn text_node(content: LoroValue) -> LoroValue {
    object(&[("resource", object(&[("content", content)]))])
}

#[test]
fn a_markdown_document_whose_body_is_a_text_node_under_another_id_is_refused() {
    let doc = LoroDoc::new();
    set(&doc, "document", "kind", "markdown");
    set(&doc, "nodes", "n1", text_node("hello".into()));
    assert_eq!(markdown_body(&doc), Err(Refusal("RetiredStoredShapeError")));
    assert_eq!(
        retired_stored_shape(&doc).as_deref(),
        Some("a markdown body stored as a canvas text node")
    );
    doc.get_text("body").insert(0, "prose").expect("text");
    assert_eq!(markdown_body(&doc), Ok("prose".to_owned()));
    assert_eq!(retired_stored_shape(&doc), None);
}

#[test]
fn a_text_node_is_a_body_only_where_the_kind_says_markdown_and_it_holds_a_string() {
    for kind in [Some("spatial"), None] {
        let doc = LoroDoc::new();
        if let Some(kind) = kind {
            set(&doc, "document", "kind", kind);
        }
        set(&doc, "nodes", "n1", text_node("hello".into()));
        assert_eq!(markdown_body(&doc), Ok(String::new()), "{kind:?}");
    }
    let doc = LoroDoc::new();
    set(&doc, "document", "kind", "markdown");
    set(&doc, "nodes", "n1", text_node(7_i64.into()));
    set(&doc, "nodes", "n2", object(&[("resource", "text".into())]));
    set(&doc, "nodes", "n3", object(&[("other", "text".into())]));
    assert_eq!(markdown_body(&doc), Ok(String::new()));
    let held = doc.get_map("nodes").insert_container("n4", LoroMap::new()).expect("map");
    held.insert("resource", "x").expect("set");
    assert_eq!(markdown_body(&doc), Ok(String::new()));
}

#[test]
fn a_retired_node_is_named_by_its_extension_key_or_its_old_kind() {
    let doc = LoroDoc::new();
    set(&doc, "nodes", "a", object(&[("type", "image".into())]));
    set(&doc, "nodes", "b", LoroValue::String("text".into()));
    assert_eq!(retired_stored_shape(&doc), None);
    set(&doc, "nodes", "c", object(&[("x-whiteboard", LoroValue::Null)]));
    assert_eq!(
        retired_stored_shape(&doc).as_deref(),
        Some("node \"c\" stored under the pre-ADR-0037 `x-whiteboard` key")
    );
    for kind in ["text", "file", "link", "group"] {
        let doc = LoroDoc::new();
        set(&doc, "nodes", "n1", object(&[("type", kind.into())]));
        assert_eq!(
            retired_stored_shape(&doc),
            Some(format!(
                "node \"n1\" stored in the pre-ADR-0038 node-kind union (type \"{kind}\")"
            ))
        );
    }
    let doc = LoroDoc::new();
    set(&doc, "nodes", "n1", object(&[("type", 4_i64.into())]));
    assert_eq!(retired_stored_shape(&doc), None);
}

#[test]
fn the_first_retired_entry_in_the_maps_key_order_is_the_one_named() {
    let doc = LoroDoc::new();
    set(&doc, "nodes", "b", object(&[("type", "text".into())]));
    set(&doc, "nodes", "a", object(&[("x-whiteboard", 1_i64.into())]));
    set(&doc, "edges", "e", object(&[("x-whiteboard", 1_i64.into())]));
    assert_eq!(
        retired_stored_shape(&doc).as_deref(),
        Some("node \"a\" stored under the pre-ADR-0037 `x-whiteboard` key")
    );
}

#[test]
fn a_retired_edge_canvas_or_elements_list_is_named_after_the_nodes() {
    let doc = LoroDoc::new();
    set(&doc, "edges", "plain", object(&[("from", "a".into())]));
    assert_eq!(retired_stored_shape(&doc), None);
    set(&doc, "edges", "e1", object(&[("x-whiteboard", 1_i64.into())]));
    assert_eq!(
        retired_stored_shape(&doc).as_deref(),
        Some("edge \"e1\" stored under the pre-ADR-0037 `x-whiteboard` key")
    );
    set(&doc, "canvas", "x-whiteboard", 1_i64);
    assert_eq!(
        retired_stored_shape(&doc).as_deref(),
        Some("edge \"e1\" stored under the pre-ADR-0037 `x-whiteboard` key")
    );
    let doc = LoroDoc::new();
    set(&doc, "canvas", "tags", "x");
    assert_eq!(retired_stored_shape(&doc), None);
    set(&doc, "canvas", "x-whiteboard", 1_i64);
    assert_eq!(
        retired_stored_shape(&doc).as_deref(),
        Some("canvas settings stored under the pre-ADR-0037 `x-whiteboard` key")
    );
}

#[test]
fn a_retired_elements_list_is_refused_only_with_entries_in_either_list_kind() {
    let doc = LoroDoc::new();
    let list = doc.get_movable_list("elements");
    assert_eq!(retired_stored_shape(&doc), None, "an unwritten root");
    list.push(1_i64).expect("push");
    list.push(2_i64).expect("push");
    assert_eq!(
        retired_stored_shape(&doc).as_deref(),
        Some("canvas elements stored as the retired Excalidraw `elements` list (2 entries)")
    );
    let plain = LoroDoc::new();
    plain.get_list("elements").push("a").expect("push");
    assert_eq!(
        retired_stored_shape(&plain).as_deref(),
        Some("canvas elements stored as the retired Excalidraw `elements` list (1 entries)")
    );
    let emptied = LoroDoc::new();
    let held = emptied.get_movable_list("elements");
    held.push(1_i64).expect("push");
    held.delete(0, 1).expect("delete");
    assert_eq!(retired_stored_shape(&emptied), None, "an emptied list carries nothing");
    let other = LoroDoc::new();
    other.get_map("elements").insert("k", 1_i64).expect("set");
    assert_eq!(retired_stored_shape(&other), None, "a root of another kind is no list");
}

#[test]
fn asking_appends_no_operation() {
    let doc = LoroDoc::new();
    set(&doc, "facets", "a.a/v1", 1_i64);
    let before = (version_pairs(&doc), frontier_pairs(&doc));
    for name in CONTENT_QUERIES {
        let _ = ask(&doc, name);
    }
    assert_eq!((version_pairs(&doc), frontier_pairs(&doc)), before);
    assert_eq!(before.0.len(), 1);
}

#[test]
fn locks_are_the_ids_held_true_sorted_by_utf16_unit() {
    let doc = LoroDoc::new();
    set(&doc, "nodeLocks", "b", true);
    set(&doc, "nodeLocks", "a", true);
    set(&doc, "nodeLocks", "off", false);
    set(&doc, "nodeLocks", "text", "true");
    set(&doc, "nodeLocks", "one", 1_i64);
    // U+FF5E is one unit above every surrogate; U+1F600 starts at one below it.
    set(&doc, "nodeLocks", "\u{FF5E}", true);
    set(&doc, "nodeLocks", "\u{1F600}", true);
    set(&doc, "edgeLocks", "e2", true);
    set(&doc, "edgeLocks", "e1", true);
    set(&doc, "edgeLocks", "e0", false);
    assert_eq!(ok_of(&doc, QueryName::NodeLocks), strings(&["a", "b", "\u{1F600}", "\u{FF5E}"]));
    assert_eq!(ok_of(&doc, QueryName::EdgeLocks), strings(&["e1", "e2"]));
}

#[test]
fn a_facet_shows_under_a_key_of_the_grammar_and_a_stray_key_stays_stored_and_unseen() {
    let doc = LoroDoc::new();
    set(&doc, "facets", "visual.style/v1", object(&[("shape", "oval".into())]));
    set(&doc, "facets", "a-b.c-d/v12", LoroValue::Null);
    set(&doc, "facets", "Visual.style/v1", 1_i64);
    set(&doc, "facets", "visual.style", 1_i64);
    set(&doc, "facets", "visual.style/v", 1_i64);
    set(&doc, "facets", "visual.style/v1x", 1_i64);
    set(&doc, "facets", "1visual.style/v1", 1_i64);
    set(&doc, "facets", "visual.1style/v1", 1_i64);
    set(&doc, "facets", "plain", 1_i64);
    let shown = ok_of(&doc, QueryName::Facets);
    assert_eq!(
        shown,
        Value::Map(vec![
            ("a-b.c-d/v12".into(), Value::Null),
            ("visual.style/v1".into(), Value::Map(vec![("shape".into(), s("oval"))])),
        ])
    );
}

#[test]
fn a_value_the_wire_has_a_marker_for_is_written_as_the_marker() {
    let doc = LoroDoc::new();
    set(&doc, "facets", "a.a/v1", object(&[("$undefined", true.into())]));
    set(&doc, "facets", "a.b/v1", object(&[("$undefined", true.into()), ("k", 1_i64.into())]));
    set(&doc, "facets", "a.c/v1", f64::NAN);
    set(&doc, "facets", "a.d/v1", f64::INFINITY);
    set(&doc, "facets", "a.e/v1", f64::NEG_INFINITY);
    set(&doc, "facets", "a.f/v1", 2.5_f64);
    set(&doc, "facets", "a.g/v1", LoroValue::List(vec![1_i64.into(), "x".into()].into()));
    let marker = |name: &str, body: Value| Value::Map(vec![(name.to_owned(), body)]);
    assert_eq!(
        ok_of(&doc, QueryName::Facets),
        Value::Map(vec![
            ("a.a/v1".into(), marker("$object", marker("$undefined", Value::Bool(true)))),
            (
                "a.b/v1".into(),
                Value::Map(vec![
                    ("$undefined".into(), Value::Bool(true)),
                    ("k".into(), Value::Number(1.0))
                ])
            ),
            ("a.c/v1".into(), marker("$number", s("NaN"))),
            ("a.d/v1".into(), marker("$number", s("Infinity"))),
            ("a.e/v1".into(), marker("$number", s("-Infinity"))),
            ("a.f/v1".into(), Value::Number(2.5)),
            ("a.g/v1".into(), Value::Seq(vec![Value::Number(1.0), s("x")])),
        ])
    );
}

#[test]
fn a_facet_holding_bytes_or_a_container_is_not_answered_here() {
    let doc = LoroDoc::new();
    set(&doc, "facets", "a.a/v1", LoroValue::Binary(vec![1_u8, 2].into()));
    assert!(answer_content_query(&doc, &Query { query: QueryName::Facets, args: None }).is_none());
    let nested = LoroDoc::new();
    let held = nested.get_map("facets").insert_container("a.a/v1", LoroMap::new()).expect("map");
    held.insert("k", 1_i64).expect("set");
    assert_eq!(ok_of(&nested, QueryName::Facets), Value::Map(vec![("a.a/v1".into(), Value::Null)]));
}

#[test]
fn a_body_delta_is_each_run_with_the_marks_over_it() {
    let doc = LoroDoc::new();
    assert_eq!(ok_of(&doc, QueryName::BodyDelta), Value::Seq(Vec::new()));
    let text = doc.get_text("body");
    text.insert(0, "Hello world").expect("text");
    assert_eq!(
        ok_of(&doc, QueryName::BodyDelta),
        Value::Seq(vec![Value::Map(vec![("insert".into(), s("Hello world"))])])
    );
    text.mark(0..5, "bold", true).expect("mark");
    assert!(matches!(text.to_delta().first(), Some(TextDelta::Insert { attributes: Some(_), .. })));
    assert_eq!(
        ok_of(&doc, QueryName::BodyDelta),
        Value::Seq(vec![
            Value::Map(vec![
                ("insert".into(), s("Hello")),
                ("attributes".into(), Value::Map(vec![("bold".into(), Value::Bool(true))])),
            ]),
            Value::Map(vec![("insert".into(), s(" world"))]),
        ])
    );
}

#[test]
fn the_retired_comment_plane_counts_its_rows() {
    let doc = LoroDoc::new();
    assert_eq!(ok_of(&doc, QueryName::RetiredCommentRows), Value::Number(0.0));
    set(&doc, "comments", "c1", "x");
    set(&doc, "comments", "c2", "y");
    assert_eq!(ok_of(&doc, QueryName::RetiredCommentRows), Value::Number(2.0));
}

#[test]
fn a_query_this_crate_does_not_answer_or_a_hosted_read_is_left_to_the_caller() {
    let doc = LoroDoc::new();
    let hosted = Value::Map(vec![("documentId".into(), s("01ARZ3NDEKTSV4RRFFQ69G5F01"))]);
    for name in CONTENT_QUERIES {
        let query = Query { query: name, args: Some(hosted.clone()) };
        assert!(answer_content_query(&doc, &query).is_none(), "{name:?} hosted");
    }
    let other = Value::Map(vec![("since".into(), Value::Seq(Vec::new()))]);
    let query = Query { query: QueryName::DocumentKind, args: Some(other) };
    assert!(answer_content_query(&doc, &query).is_some());
    for name in [QueryName::Documents, QueryName::StateSize, QueryName::ContentDigest] {
        assert!(answer_content_query(&doc, &Query { query: name, args: None }).is_none());
    }
    assert_eq!(CONTENT_QUERIES.len(), 20);
}
