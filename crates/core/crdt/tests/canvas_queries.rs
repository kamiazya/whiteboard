//! The canvas, content and envelope-facet queries over documents written
//! here, for the arrangements the recording lacks: the records the model's
//! schema refuses, a facet bucket or tag list it reads as absent, and a
//! retired shape that refuses the whole read. Each expected answer is what
//! the TypeScript answered for the same stored document.

use loro::{LoroDoc, LoroMapValue, LoroValue};
use serde_json::{Value as Json, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::answer_content_query;
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName};

const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

#[cfg(test)]
fn lv(json: &Json) -> LoroValue {
    match json {
        Json::Null => LoroValue::Null,
        Json::Bool(b) => LoroValue::Bool(*b),
        Json::Number(n) => n
            .as_i64()
            .map_or_else(|| LoroValue::Double(n.as_f64().expect("a double")), LoroValue::I64),
        Json::String(s) => LoroValue::from(s.as_str()),
        Json::Array(items) => LoroValue::from(items.iter().map(lv).collect::<Vec<_>>()),
        Json::Object(entries) => LoroValue::Map(
            entries.iter().map(|(k, v)| (k.clone(), lv(v))).collect::<LoroMapValue>(),
        ),
    }
}

#[cfg(test)]
fn doc_of(stored: &[(&str, &str, Json)]) -> LoroDoc {
    let doc = LoroDoc::new();
    for (root, key, value) in stored {
        doc.get_map(*root).insert(key, lv(value)).expect("set");
    }
    doc
}

#[cfg(test)]
fn query(name: QueryName, kind: Option<&str>) -> Query {
    let args = kind.map(|k| Value::Map(vec![("kind".to_owned(), Value::String(k.to_owned()))]));
    Query { query: name, args }
}

/// A recorded JSON value as the model's, a mapping's keys sorted as the
/// answers write them.
#[cfg(test)]
fn model_of(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Number(n.as_f64().expect("a double")),
        Json::String(s) => Value::String(s.clone()),
        Json::Array(items) => Value::Seq(items.iter().map(model_of).collect()),
        Json::Object(entries) => {
            let mut map: Vec<(String, Value)> =
                entries.iter().map(|(k, v)| (k.clone(), model_of(v))).collect();
            map.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Map(map)
        }
    }
}

#[cfg(test)]
fn assert_same(label: &str, answer: &Value, expected: &Value) {
    assert_eq!(answer, expected, "{label}");
}

/// Asserts the answer equals the recorded form `expected`.
#[cfg(test)]
fn check(label: &str, doc: &LoroDoc, name: QueryName, expected: &Json) {
    let answer = answer_content_query(doc, &query(name, None)).expect(label);
    assert_same(label, &answer.value, &model_of(expected));
}

fn node(extra: &Json) -> Json {
    let mut base = json!({ "id": "n", "x": 0, "y": 0, "width": 1, "height": 1 });
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        base.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    base
}

fn canvas_of(nodes: &[Json], skipped: u32) -> Json {
    json!({ "ok": { "canvas": { "nodes": nodes, "edges": [] }, "skipped": skipped } })
}

#[test]
fn a_node_the_schema_refuses_is_skipped_and_counted() {
    let refused = [
        ("an unnamed key", json!({ "foo": 1 })),
        ("a null colour", json!({ "color": null })),
        ("a negative width", json!({ "width": -1 })),
        ("a short hex colour", json!({ "color": "#abc" })),
        ("a preset past six", json!({ "color": "7" })),
        ("a bad embed id", json!({ "embed": { "documentId": "x" } })),
        ("an empty version ref", json!({ "embed": { "documentId": ULID, "versionRef": "" } })),
        (
            "a link that is no URL",
            json!({ "resource": { "mimeType": "text/uri-list", "location": "x" } }),
        ),
        (
            "content and a location",
            json!({ "resource": { "mimeType": "a", "location": "x", "content": "y" } }),
        ),
        ("a resource key unnamed", json!({ "resource": { "mimeType": "a", "foo": 1 } })),
        ("an empty media type", json!({ "resource": { "mimeType": "" } })),
        (
            "a subpath with no hash",
            json!({ "resource": { "mimeType": "a", "location": "x", "subpath": "x" } }),
        ),
        (
            "a resource and a label",
            json!({ "resource": { "mimeType": "a", "location": "x" }, "label": "x" }),
        ),
        ("an unknown background style", json!({ "backgroundStyle": "x" })),
        ("an empty id", json!({ "id": "" })),
    ];
    for (label, extra) in refused {
        let doc = doc_of(&[("nodes", "n", node(&extra))]);
        check(label, &doc, QueryName::SpatialCanvas, &canvas_of(&[], 1));
        check(label, &doc, QueryName::SpatialNodeCount, &json!({ "ok": 0 }));
    }
}

#[test]
fn a_node_holding_a_double_the_schema_refuses_is_skipped() {
    let fields =
        [("x", f64::NAN), ("y", f64::NEG_INFINITY), ("width", f64::INFINITY), ("height", -0.5)];
    for (key, held) in fields {
        let LoroValue::Map(stored) = lv(&node(&json!({}))) else { unreachable!() };
        let record: LoroMapValue = stored
            .iter()
            .filter(|(k, _)| k.as_str() != key)
            .map(|(k, v)| (k.clone(), v.clone()))
            .chain([(key.to_owned(), LoroValue::Double(held))])
            .collect();
        let doc = LoroDoc::new();
        doc.get_map("nodes").insert("n", LoroValue::Map(record)).expect("set");
        check(key, &doc, QueryName::SpatialCanvas, &canvas_of(&[], 1));
    }
}

#[test]
fn a_node_the_schema_accepts_is_kept_as_stored() {
    let kept = [
        json!({}),
        json!({ "x": 1.5, "width": 0, "height": 0 }),
        json!({ "color": "#a1B2c3" }),
        json!({ "color": "3" }),
        json!({ "embed": { "documentId": ULID, "versionRef": "v" } }),
        json!({ "resource": { "mimeType": "text/uri-list", "location": "http://a.b/" } }),
        json!({ "resource": { "mimeType": "text/markdown", "content": "hi" } }),
        json!({ "resource": { "mimeType": "a", "location": "x", "subpath": "#s" } }),
        json!({ "label": "l", "background": "b", "backgroundStyle": "cover" }),
        json!({ "tags": ["a", "b:c"] }),
        json!({ "facets": {} }),
        json!({ "facets": { "a.b/v1": { "x": 1 } } }),
    ];
    for extra in kept {
        let stored = node(&extra);
        let doc = doc_of(&[("nodes", "n", stored.clone())]);
        check("kept", &doc, QueryName::SpatialCanvas, &canvas_of(&[stored], 0));
        check("kept", &doc, QueryName::SpatialNodeCount, &json!({ "ok": 1 }));
    }
}

#[test]
fn a_malformed_facet_bucket_or_tag_list_costs_the_field_and_not_the_record() {
    let malformed = [
        ("facets", json!(null)),
        ("facets", json!({ "BAD": 1 })),
        ("facets", json!([1])),
        ("facets", json!(3)),
        ("tags", json!(null)),
        ("tags", json!([1])),
        ("tags", json!({ "a": 1 })),
        ("tags", json!(3)),
    ];
    for (field, bad) in malformed {
        let doc = doc_of(&[("nodes", "n", node(&json!({ field: bad })))]);
        let shown = node(&json!({ field: { "$undefined": true } }));
        check(&format!("{field} {bad}"), &doc, QueryName::SpatialCanvas, &canvas_of(&[shown], 0));
    }
}

#[test]
fn an_edge_and_a_line_are_held_to_their_own_schemas() {
    let edge = json!({ "id": "e", "from": { "node": "n" }, "to": { "node": "n" } });
    let with = |extra: Json| {
        let mut e = edge.clone();
        e.as_object_mut().expect("an object").extend(extra.as_object().expect("an object").clone());
        e
    };
    let refused = [
        with(json!({ "from": { "kind": "node", "node": "n" } })),
        with(json!({ "from": { "node": "n", "side": "diag" } })),
        with(json!({ "to": { "node": "n", "end": "x" } })),
        with(json!({ "to": { "node": "" } })),
        with(json!({ "bends": [] })),
        with(json!({ "bends": vec![json!({ "x": 1, "y": 2 }); 65] })),
        with(json!({ "bends": [{ "x": 1, "y": 2, "z": 3 }] })),
        with(json!({ "extra": 1 })),
    ];
    for stored in refused {
        let doc = doc_of(&[("edges", "e", stored)]);
        check("an edge", &doc, QueryName::SpatialCanvas, &canvas_of(&[], 1));
    }
    let kept = [
        with(json!({ "from": { "node": "n", "side": "left", "end": "arrow" } })),
        with(json!({ "bends": vec![json!({ "x": 1, "y": 2 }); 64] })),
        with(
            json!({ "color": "#112233", "label": "", "tags": ["a"], "facets": { "a.b/v2": [1, null] } }),
        ),
    ];
    for stored in kept {
        let doc = doc_of(&[("edges", "e", stored.clone())]);
        let want = json!({ "ok": { "canvas": { "nodes": [], "edges": [stored] }, "skipped": 0 } });
        check("an edge", &doc, QueryName::SpatialCanvas, &want);
    }
}

#[test]
fn a_line_is_held_to_its_own_schema() {
    let point = |x: i64| json!({ "kind": "point", "point": { "x": x, "y": 2 } });
    let on = |n: &str| json!({ "kind": "node", "node": n });
    let line = |from: Json, to: Json| json!({ "id": "l", "from": from, "to": to });
    let refused_lines = [
        line(json!({ "kind": "x" }), on("z")),
        line(json!({ "node": "a" }), on("z")),
        line(json!({ "kind": "point", "point": { "x": 1, "y": 2 }, "node": "a" }), on("z")),
        line(json!({ "kind": "node", "node": "a", "point": { "x": 1, "y": 2 } }), on("z")),
        json!({ "id": "l", "from": point(1), "to": on("z"), "tags": ["a"] }),
    ];
    for stored in refused_lines {
        let doc = doc_of(&[("lines", "l", stored)]);
        check("a line", &doc, QueryName::SpatialCanvas, &canvas_of(&[], 1));
    }
    let drawn = json!({ "id": "l", "from": { "kind": "point", "point": { "x": 1, "y": 2 }, "end": "arrow" },
        "to": { "kind": "node", "node": "z", "side": "top" }, "label": "x" });
    let doc = doc_of(&[("lines", "l", drawn.clone())]);
    let want =
        json!({ "ok": { "canvas": { "nodes": [], "edges": [], "lines": [drawn] }, "skipped": 0 } });
    check("a line", &doc, QueryName::SpatialCanvas, &want);
}

#[test]
fn a_facet_payload_is_written_as_the_wire_writes_it() {
    let payloads = [
        (json!({ "$undefined": true }), json!({ "$object": { "$undefined": true } })),
        (json!({ "$object": 1 }), json!({ "$object": { "$object": 1 } })),
        (json!({ "y": 1, "x": [1, 2.5] }), json!({ "x": [1, 2.5], "y": 1 })),
    ];
    for (stored, written) in payloads {
        let doc = doc_of(&[("nodes", "n", node(&json!({ "facets": { "a.b/v1": stored } })))]);
        let shown = node(&json!({ "facets": { "a.b/v1": written } }));
        check("a facet payload", &doc, QueryName::SpatialCanvas, &canvas_of(&[shown], 0));
    }
}

#[test]
fn a_canvas_reads_its_own_facets_and_tags() {
    let set = |key: &str, value: Json| doc_of(&[("canvas", key, value)]);
    let want = |extra: Json, skipped: u32| {
        let mut canvas = json!({ "nodes": [], "edges": [] });
        canvas
            .as_object_mut()
            .expect("an object")
            .extend(extra.as_object().expect("an object").clone());
        json!({ "ok": { "canvas": canvas, "skipped": skipped } })
    };
    let cases = [
        (
            set("facets", json!({ "a.b/v1": 1, "BAD": 2 })),
            want(json!({ "facets": { "a.b/v1": 1 } }), 1),
        ),
        (set("facets", json!({ "BAD": 2 })), want(json!({}), 1)),
        (set("facets", json!({})), want(json!({ "facets": {} }), 0)),
        (set("facets", json!(null)), want(json!({}), 0)),
        (set("tags", json!(["a", "b"])), want(json!({ "tags": ["a", "b"] }), 0)),
        (set("tags", json!("a")), want(json!({}), 0)),
    ];
    for (doc, expected) in cases {
        check("the canvas", &doc, QueryName::SpatialCanvas, &expected);
    }
}

#[test]
fn records_keep_the_order_of_the_map_and_a_repeated_id_stays() {
    let nodes: Vec<(String, Json)> = ["b", "a", "C", "10", "2"]
        .iter()
        .map(|k| ((*k).to_owned(), node(&json!({ "id": k }))))
        .collect();
    let stored: Vec<(&str, &str, Json)> =
        nodes.iter().map(|(k, v)| ("nodes", k.as_str(), v.clone())).collect();
    let doc = doc_of(&stored);
    let ordered: Vec<Json> =
        ["10", "2", "C", "a", "b"].iter().map(|k| node(&json!({ "id": k }))).collect();
    check("the order", &doc, QueryName::SpatialCanvas, &canvas_of(&ordered, 0));
    let twice = doc_of(&[
        ("nodes", "a", node(&json!({ "id": "x" }))),
        ("nodes", "b", node(&json!({ "id": "x" }))),
    ]);
    check("a repeat", &twice, QueryName::SpatialNodeCount, &json!({ "ok": 2 }));
}

#[test]
fn a_retired_shape_refuses_the_canvas_and_counts_none() {
    let line = json!({ "id": "l", "from": { "kind": "point", "point": { "x": 1, "y": 2 } },
        "to": { "kind": "point", "point": { "x": 1, "y": 2 } } });
    let refusal = json!({ "err": "RetiredStoredShapeError" });
    let retired_node =
        doc_of(&[("lines", "l", line), ("nodes", "n", json!({ "type": "text", "id": "n" }))]);
    check("a retired node", &retired_node, QueryName::SpatialCanvas, &refusal);
    check("a retired node", &retired_node, QueryName::SpatialNodeCount, &json!({ "ok": 0 }));
    let settings =
        doc_of(&[("canvas", "x-whiteboard", json!({})), ("nodes", "n", node(&json!({})))]);
    check("retired settings", &settings, QueryName::SpatialCanvas, &refusal);
    check("retired settings", &settings, QueryName::SpatialNodeCount, &json!({ "ok": 0 }));
    let elements = LoroDoc::new();
    elements.get_list("elements").push(1).expect("push");
    check("retired elements", &elements, QueryName::SpatialCanvas, &refusal);
}

#[test]
fn content_is_the_half_the_kind_names() {
    let body = |doc: &LoroDoc, text: &str| doc.get_text("body").insert(0, text).expect("insert");
    let markdown = doc_of(&[
        ("document", "kind", json!("markdown")),
        ("core", "type", json!("t")),
        ("core", "description", json!("dd")),
        ("core", "tags", json!(["a"])),
    ]);
    body(&markdown, "hi");
    check(
        "markdown",
        &markdown,
        QueryName::DocumentContent,
        &json!({ "ok": { "kind": "markdown", "body": "hi", "description": "dd" } }),
    );
    check(
        "markdown",
        &markdown,
        QueryName::DocumentContentWithTags,
        &json!({ "ok": {
        "content": { "kind": "markdown", "body": "hi", "description": "dd" }, "tags": ["a"] } }),
    );
    let bare = doc_of(&[
        ("document", "kind", json!("markdown")),
        ("core", "type", json!("t")),
        ("core", "tags", json!([])),
    ]);
    check(
        "no summary",
        &bare,
        QueryName::DocumentContentWithTags,
        &json!({ "ok": { "content": { "kind": "markdown", "body": "" }, "tags": [] } }),
    );
}

#[test]
fn content_without_a_type_or_for_a_spatial_document_carries_no_summary() {
    let untyped =
        doc_of(&[("document", "kind", json!("markdown")), ("core", "description", json!("d"))]);
    check(
        "no type",
        &untyped,
        QueryName::DocumentContentWithTags,
        &json!({ "ok": { "content": { "kind": "markdown", "body": "" } } }),
    );
    let spatial = doc_of(&[
        ("document", "kind", json!("spatial")),
        ("core", "type", json!("t")),
        ("core", "tags", json!(["a"])),
    ]);
    check(
        "spatial",
        &spatial,
        QueryName::DocumentContentWithTags,
        &json!({ "ok": { "content": { "kind": "spatial", "canvas": { "nodes": [], "edges": [] } } } }),
    );
}

#[test]
fn a_kind_asked_for_decides_only_a_document_that_states_none() {
    let unstated = LoroDoc::new();
    unstated.get_text("body").insert(0, "hi").expect("insert");
    let asked = |doc: &LoroDoc, kind: &str| {
        answer_content_query(doc, &query(QueryName::DocumentContent, Some(kind)))
            .expect("answered")
            .value
    };
    assert_same(
        "asked markdown",
        &asked(&unstated, "markdown"),
        &model_of(&json!({ "ok": { "kind": "markdown", "body": "hi" } })),
    );
    assert_same(
        "asked spatial",
        &asked(&unstated, "spatial"),
        &model_of(&json!({ "ok": { "kind": "spatial", "canvas": { "nodes": [], "edges": [] } } })),
    );
    let stated = doc_of(&[("document", "kind", json!("spatial"))]);
    assert_same(
        "stated wins",
        &asked(&stated, "markdown"),
        &model_of(&json!({ "ok": { "kind": "spatial", "canvas": { "nodes": [], "edges": [] } } })),
    );
    assert!(
        answer_content_query(&unstated, &query(QueryName::DocumentContent, Some("zzz"))).is_none()
    );
    let extra = Query {
        query: QueryName::DocumentContent,
        args: Some(Value::Map(vec![
            ("kind".to_owned(), Value::String("markdown".to_owned())),
            ("other".to_owned(), Value::Number(1.0)),
        ])),
    };
    assert!(answer_content_query(&unstated, &extra).is_none());
    let named_otherwise = Query {
        query: QueryName::DocumentContent,
        args: Some(Value::Map(vec![("other".to_owned(), Value::String("markdown".to_owned()))])),
    };
    assert!(answer_content_query(&unstated, &named_otherwise).is_none());
    let empty = Query { query: QueryName::DocumentContent, args: Some(Value::Map(Vec::new())) };
    assert_same(
        "empty arguments",
        &answer_content_query(&unstated, &empty).expect("answered").value,
        &model_of(&json!({ "ok": { "kind": "spatial", "canvas": { "nodes": [], "edges": [] } } })),
    );
    // `query.args ?? {}`: null reads as no arguments, while any other
    // non-object is refused by the reader's object schema.
    let null = Query { query: QueryName::DocumentContent, args: Some(Value::Null) };
    assert_same(
        "null arguments",
        &answer_content_query(&unstated, &null).expect("answered").value,
        &model_of(&json!({ "ok": { "kind": "spatial", "canvas": { "nodes": [], "edges": [] } } })),
    );
    for args in [Value::String("markdown".to_owned()), Value::Number(1.0), Value::Seq(Vec::new())] {
        let not_an_object = Query { query: QueryName::DocumentContent, args: Some(args) };
        assert!(answer_content_query(&unstated, &not_an_object).is_none(), "{not_an_object:?}");
    }
}

#[test]
fn a_markdown_body_stored_as_a_canvas_node_refuses_the_content() {
    let text_node = node(&json!({ "resource": { "mimeType": "text/markdown", "content": "x" } }));
    let refusal = json!({ "err": "RetiredStoredShapeError" });
    let stated =
        doc_of(&[("document", "kind", json!("markdown")), ("nodes", "n", text_node.clone())]);
    check("stated", &stated, QueryName::DocumentContent, &refusal);
    let asked = doc_of(&[("nodes", "n", text_node)]);
    let answer = answer_content_query(&asked, &query(QueryName::DocumentContent, Some("markdown")))
        .expect("answered");
    assert_same("asked", &answer.value, &model_of(&refusal));
}

#[test]
fn core_facets_keep_the_fields_the_schema_reads() {
    let full = doc_of(&[
        ("core", "type", json!("t")),
        ("core", "title", json!("T")),
        ("core", "description", json!("d")),
        ("core", "resource", json!("r")),
        ("core", "tags", json!(["a"])),
        ("core", "view", json!("v")),
        ("core", "facetsRaw", json!({ "k": [1] })),
        ("core", "other", json!(1)),
    ]);
    check(
        "full",
        &full,
        QueryName::CoreFacets,
        &json!({ "ok": {
        "type": "t", "description": "d", "resource": "r", "tags": ["a"], "view": "v", "facetsRaw": { "k": [1] } } }),
    );
    let dropped = doc_of(&[
        ("core", "type", json!("t")),
        ("core", "tags", json!([1])),
        ("core", "description", json!(null)),
        ("core", "view", json!(3)),
        ("core", "facetsRaw", json!({ "type": 1 })),
    ]);
    check("dropped", &dropped, QueryName::CoreFacets, &json!({ "ok": { "type": "t" } }));
    let none = json!({ "ok": { "$undefined": true } });
    check("no type", &doc_of(&[("core", "description", json!("d"))]), QueryName::CoreFacets, &none);
    check(
        "empty type",
        &doc_of(&[("core", "type", json!("")), ("core", "title", json!("t"))]),
        QueryName::CoreFacets,
        &none,
    );
    let spatial = doc_of(&[("document", "kind", json!("spatial")), ("core", "type", json!("a"))]);
    check("spatial", &spatial, QueryName::CoreFacets, &none);
}

#[test]
fn trust_facets_keep_the_fields_whose_events_the_schema_reads() {
    let at = "2020-01-01T00:00:00Z";
    let none = json!({ "ok": { "$undefined": true } });
    let kept = doc_of(&[
        ("trust", "verified", json!([{ "by": "a", "at": at, "z": 1 }])),
        ("trust", "generated", json!({ "by": "a" })),
        ("trust", "junk", json!(1)),
    ]);
    check(
        "kept",
        &kept,
        QueryName::TrustFacets,
        &json!({ "ok": { "verified": [{ "by": "a", "at": at, "z": 1 }] } }),
    );
    let generated = doc_of(&[
        ("trust", "generated", json!({ "by": "a", "at": at })),
        ("trust", "junk", json!(1)),
    ]);
    check(
        "generated",
        &generated,
        QueryName::TrustFacets,
        &json!({ "ok": { "generated": { "by": "a", "at": at } } }),
    );
    check("junk", &doc_of(&[("trust", "junk", json!(1))]), QueryName::TrustFacets, &none);
}

#[test]
fn a_trust_field_with_an_event_the_schema_refuses_is_dropped() {
    let at = "2020-01-01T00:00:00Z";
    let none = json!({ "ok": { "$undefined": true } });
    check(
        "empty list",
        &doc_of(&[("trust", "verified", json!([]))]),
        QueryName::TrustFacets,
        &json!({ "ok": { "verified": [] } }),
    );
    check(
        "padded actor",
        &doc_of(&[
            ("trust", "generated", json!({ "by": " a", "at": at })),
            ("trust", "verified", json!([{ "by": "x", "at": "2020-01-01T00:00:00+01:00" }])),
        ]),
        QueryName::TrustFacets,
        &json!({ "ok": { "verified": [{ "by": "x", "at": "2020-01-01T00:00:00+01:00" }] } }),
    );
    check(
        "one bad event",
        &doc_of(&[(
            "trust",
            "verified",
            json!([{ "by": "x", "at": at }, { "by": "x", "at": "nope" }]),
        )]),
        QueryName::TrustFacets,
        &none,
    );
    check(
        "empty actor",
        &doc_of(&[("trust", "generated", json!({ "by": "", "at": at }))]),
        QueryName::TrustFacets,
        &none,
    );
    check(
        "spatial",
        &doc_of(&[("document", "kind", json!("spatial")), ("trust", "verified", json!([]))]),
        QueryName::TrustFacets,
        &none,
    );
}

#[test]
fn a_facet_payload_the_wire_cannot_write_is_not_answered_here() {
    let doc = LoroDoc::new();
    let LoroValue::Map(stored) = lv(&node(&json!({}))) else { unreachable!() };
    let bucket = LoroValue::Map(
        [("a.b/v1".to_owned(), LoroValue::Binary(vec![1].into()))]
            .into_iter()
            .collect::<LoroMapValue>(),
    );
    let record: LoroMapValue = stored
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .chain([("facets".to_owned(), bucket)])
        .collect();
    doc.get_map("nodes").insert("n", LoroValue::Map(record)).expect("set");
    assert!(answer_content_query(&doc, &query(QueryName::SpatialCanvas, None)).is_none());
    let count = answer_content_query(&doc, &query(QueryName::SpatialNodeCount, None));
    assert_same(
        "the count needs no write",
        &count.expect("answered").value,
        &model_of(&json!({ "ok": 1 })),
    );
}
