//! The stored-record schema as properties over documents written here: a
//! record valid by construction is kept as stored, whatever else the map
//! holds, and a record broken one way is skipped alone and counted.
//!
//! The expectation is the identity on what was stored, so it shares nothing
//! with the reader it judges.

use loro::{LoroDoc, LoroMapValue, LoroValue};
use serde_json::{Value as Json, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::answer_content_query;
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName};
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, any, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};

const COLORS: &[&str] = &["1", "6", "#000000", "#a1B2c3"];
const FACETS: &[&str] = &["visual.shape/v0", "a.b/v12"];

#[cfg(test)]
fn lv(json: &Json) -> LoroValue {
    match json {
        Json::Null => LoroValue::Null,
        Json::Bool(b) => LoroValue::Bool(*b),
        Json::Number(n) => {
            n.as_i64().map_or_else(|| LoroValue::Double(n.as_f64().unwrap_or(0.0)), LoroValue::I64)
        }
        Json::String(s) => LoroValue::from(s.as_str()),
        Json::Array(items) => LoroValue::from(items.iter().map(lv).collect::<Vec<_>>()),
        Json::Object(entries) => LoroValue::Map(
            entries.iter().map(|(k, v)| (k.clone(), lv(v))).collect::<LoroMapValue>(),
        ),
    }
}

#[cfg(test)]
fn model_of(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Number(n.as_f64().unwrap_or(0.0)),
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
fn coordinate() -> impl Strategy<Value = Json> {
    prop_oneof![
        (-1000_i64..1000).prop_map(|n| json!(n)),
        (-1000_i32..1000).prop_map(|n| json!(f64::from(n) / 8.0))
    ]
}

#[cfg(test)]
fn size() -> impl Strategy<Value = Json> {
    prop_oneof![
        (0_i64..1000).prop_map(|n| json!(n)),
        (0_i32..1000).prop_map(|n| json!(f64::from(n) / 8.0))
    ]
}

#[cfg(test)]
fn resource() -> impl Strategy<Value = Json> {
    prop_oneof![
        any::<String>().prop_map(|c| json!({ "mimeType": "text/markdown", "content": c })),
        any::<String>().prop_map(
            |l| json!({ "mimeType": "application/octet-stream", "location": l, "subpath": "#s" })
        ),
        Just(json!({ "mimeType": "text/uri-list", "location": "https://example.com/a?b#c" })),
    ]
}

#[cfg(test)]
fn facets() -> impl Strategy<Value = Json> {
    prop::collection::btree_map(prop::sample::select(FACETS), any::<Option<i32>>(), 0..3)
        .prop_map(|m| json!(m))
}

#[cfg(test)]
fn tags() -> impl Strategy<Value = Json> {
    prop::collection::vec(any::<String>(), 0..4).prop_map(|t| json!(t))
}

/// A node valid by construction: a resource and a frame's fields never together.
#[cfg(test)]
fn node(id: String) -> impl Strategy<Value = Json> {
    (
        (coordinate(), coordinate(), size(), size()),
        prop::option::of(prop::sample::select(COLORS)),
        prop::option::of(resource()),
        (prop::option::of(any::<String>()), prop::option::of(facets()), prop::option::of(tags())),
    )
        .prop_map(move |((x, y, width, height), color, resource, (label, facets, tags))| {
            let mut node = json!({ "id": id, "x": x, "y": y, "width": width, "height": height });
            let fields = node.as_object_mut().expect("an object");
            let mut put = |key: &str, value: Option<Json>| {
                if let Some(value) = value {
                    fields.insert(key.to_owned(), value);
                }
            };
            put("color", color.map(|c| json!(c)));
            put("facets", facets);
            put("tags", tags);
            match resource {
                Some(resource) => put("resource", Some(resource)),
                None => put("label", label.map(|l| json!(l))),
            }
            node
        })
}

/// Records under distinct map keys, each named by its own id.
#[cfg(test)]
fn nodes() -> impl Strategy<Value = Vec<Json>> {
    prop::collection::btree_set("[a-z0-9]{1,6}", 0..6)
        .prop_flat_map(|ids| ids.into_iter().map(node).collect::<Vec<_>>())
}

/// One way to break a node the schema refuses.
#[cfg(test)]
fn broken(mut node: Json, how: u8) -> Json {
    let fields = node.as_object_mut().expect("an object");
    match how % 5 {
        0 => fields.insert("unnamed".to_owned(), json!(1)),
        1 => fields.insert("width".to_owned(), json!(-1)),
        2 => fields.insert("color".to_owned(), json!(null)),
        3 => fields.insert("id".to_owned(), json!("")),
        _ => fields.remove("x"),
    };
    node
}

#[cfg(test)]
fn doc_of(nodes: &[Json]) -> LoroDoc {
    let doc = LoroDoc::new();
    let map = doc.get_map("nodes");
    for (at, node) in nodes.iter().enumerate() {
        map.insert(&format!("k{at:03}"), lv(node)).expect("set");
    }
    doc
}

#[cfg(test)]
fn canvas_answer(doc: &LoroDoc) -> Value {
    answer_content_query(doc, &Query { query: QueryName::SpatialCanvas, args: None })
        .expect("answered")
        .value
}

#[test]
#[cfg(test)]
fn a_node_valid_by_construction_is_kept_exactly_as_stored() {
    let kept = Floor::new("a canvas holding several nodes");
    let framed = Floor::new("a canvas holding a node with a resource");
    check(nodes(), None, |nodes| {
        kept.draw(nodes.len() > 2);
        framed.draw(nodes.iter().any(|n| n.get("resource").is_some()));
        let want = json!({ "ok": { "canvas": { "nodes": nodes, "edges": [] }, "skipped": 0 } });
        prop_assert_eq!(canvas_answer(&doc_of(&nodes)), model_of(&want));
        let count = answer_content_query(
            &doc_of(&nodes),
            &Query { query: QueryName::SpatialNodeCount, args: None },
        );
        prop_assert_eq!(count.expect("answered").value, model_of(&json!({ "ok": nodes.len() })));
        Ok(())
    });
    kept.assert(40);
    framed.assert(40);
}

#[test]
#[cfg(test)]
fn a_node_broken_one_way_is_skipped_alone_and_counted() {
    let mixed = Floor::new("a canvas with a node kept and a node broken");
    check((nodes(), prop::collection::vec(any::<u8>(), 6)), None, |(nodes, hows)| {
        let drawn: Vec<(Json, bool)> =
            nodes
                .iter()
                .zip(&hows)
                .map(|(n, how)| {
                    if how % 2 == 0 {
                        (broken(n.clone(), how / 2), true)
                    } else {
                        (n.clone(), false)
                    }
                })
                .collect();
        let stored: Vec<Json> = drawn.iter().map(|(n, _)| n.clone()).collect();
        let kept: Vec<Json> = drawn.iter().filter(|(_, b)| !b).map(|(n, _)| n.clone()).collect();
        let skipped = drawn.iter().filter(|(_, b)| *b).count();
        mixed.draw(!kept.is_empty() && skipped > 0);
        let want =
            json!({ "ok": { "canvas": { "nodes": kept, "edges": [] }, "skipped": skipped } });
        prop_assert_eq!(canvas_answer(&doc_of(&stored)), model_of(&want));
        prop_assert!(skipped <= stored.len());
        Ok(())
    });
    mixed.assert(40);
}
