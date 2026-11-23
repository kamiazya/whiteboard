//! The annotation layer, proposal and image-reference queries over documents
//! written here, for the arrangements the recording lacks: each anchor and
//! change shape the schema accepts or refuses, a record stored as a value where
//! a container belongs, the order two ids sort in, and what a body names.
//!
//! `fixtures/annotation_cases.jsonl` holds each stored document as the steps
//! that build it and the answer the TypeScript gave for it. A step is a map
//! container or a plain value at a path under a root map, or the body text
//! with its marks (UTF-16 offsets).

#[cfg(test)]
#[expect(dead_code, reason = "the shared helpers are each used by some of the recordings' tests")]
mod support;

use loro::{ExpandType, LoroDoc, LoroMap, LoroMapValue, LoroValue, StyleConfig, StyleConfigMap};
use serde_json::Value as Json;
use support::{assert_same, model_of, rows_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::answer_content_query;
use whiteboard_model::crdt::{Query, QueryName};

const CASES: &str = include_str!("fixtures/annotation_cases.jsonl");

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
fn text_step(doc: &LoroDoc, step: &Json) {
    let text = doc.get_text("body");
    text.insert(0, step["text"].as_str().expect("text")).expect("insert");
    let marks = step["marks"].as_array().cloned().unwrap_or_default();
    let mut styles = StyleConfigMap::new();
    for mark in &marks {
        let key = mark[2].as_str().expect("a key");
        styles.insert(key.into(), StyleConfig { expand: ExpandType::None });
    }
    doc.config_text_style(styles);
    for mark in &marks {
        let (start, end) = (mark[0].as_u64().expect("start"), mark[1].as_u64().expect("end"));
        let range = usize::try_from(start).expect("usize")..usize::try_from(end).expect("usize");
        text.mark_utf16(range, mark[2].as_str().expect("a key"), true).expect("mark");
    }
}

#[cfg(test)]
fn path_step(doc: &LoroDoc, step: &Json) {
    let path: Vec<&str> = step["path"]
        .as_array()
        .expect("a path")
        .iter()
        .map(|s| s.as_str().expect("a key"))
        .collect();
    let (last, parents) = path.split_last().expect("a key");
    let (root, inner) = parents.split_first().expect("a root");
    let mut parent: LoroMap = doc.get_map(*root);
    for key in inner {
        parent = parent
            .get(key)
            .and_then(|held| held.into_container().ok()?.into_map().ok())
            .expect("a map");
    }
    if step.get("map").is_some() {
        parent.insert_container(last, LoroMap::new()).expect("container");
    } else {
        parent.insert(last, lv(&step["value"])).expect("value");
    }
}

#[cfg(test)]
fn built(ops: &[Json]) -> LoroDoc {
    let doc = LoroDoc::new();
    for step in ops {
        if step.get("text").is_some() {
            text_step(&doc, step);
        } else if let Some(name) = step.get("rootList") {
            doc.get_list(name.as_str().expect("a name")).insert(0, "x").expect("list");
        } else {
            path_step(&doc, step);
        }
    }
    doc.commit();
    doc
}

#[test]
fn every_stored_arrangement_is_answered_as_the_typescript_answered_it() {
    let rows = rows_of(CASES);
    assert!(rows.len() > 200, "{} cases", rows.len());
    for row in &rows {
        let name = row["name"].as_str().expect("a name");
        let query = QueryName::from_wire(row["query"].as_str().expect("a query")).expect("known");
        let doc = built(row["ops"].as_array().expect("ops"));
        let answer = answer_content_query(&doc, &Query { query, args: None })
            .unwrap_or_else(|| panic!("{name}: not answered"));
        assert_same(name, &answer.value, &model_of(&row["expect"]));
    }
}
